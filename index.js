// DeepSeek Cache Optimizer v2.0
// 新增功能：
// 1. 自适应排序引擎 - 对比两次请求完整 messages 差异，最大化前缀匹配
// 2. 世界书缓存优化 - 剥离世界书条目的动态注释至尾部
// 3. 跨会话缓存复用评估 - 分析不同会话 System Prompt 相似度

import { eventSource, event_types, saveSettingsDebounced, getContext } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getApiSettings } from '../../index.js';

const EXTENSION_NAME = 'DeepSeekCacheOptimizer';
const DEFAULT_SETTINGS = {
    enabled: true,
    debug_enabled: true,
    adaptive_sorting: true,          // 自适应排序引擎
    worldinfo_optimization: true,    // 世界书动态剥离
    cross_session_eval: true,        // 跨会话评估
    deepseek_only: true,             // 仅对 DeepSeek API 优化
    dynamic_patterns: [              // 世界书动态部分正则
        '\\(概率[^)]*\\)',
        '\\(触发[^)]*\\)',
        '\\(已触发[^)]*\\)',
        '\\(持续[^)]*\\)',
        '\\(剩余[^)]*\\)',
        '\\[动态\\].*?\\[/动态\\]'
    ],
    last_sent_messages: null,        // 上次发送的完整 messages
    session_profiles: {}             // 跨会话 system prompt 摘要
};

// ========== Debug 系统 ==========
function debugLog(message, data = null, isError = false) {
    const context = getContext();
    const settings = context?.extensionSettings?.[EXTENSION_NAME];
    if (!settings?.debug_enabled) return;

    const prefix = `[${EXTENSION_NAME}]`;
    if (isError) {
        console.error(`${prefix} ❌ ${message}`, data || '');
        if (typeof toastr !== 'undefined') toastr.error(message);
    } else {
        console.log(`${prefix} ✅ ${message}`, data || '');
    }
}

// ========== 工具函数 ==========
function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// 获取当前 API 名称
function getCurrentApi() {
    try {
        const apiSettings = getApiSettings();
        return apiSettings?.main_api || '';
    } catch (e) {
        return '';
    }
}

// 检查是否为 DeepSeek API
function isDeepSeekApi() {
    const api = getCurrentApi();
    return api.toLowerCase().includes('deepseek');
}

// 序列化消息用于比较
function serializeMessage(msg) {
    return JSON.stringify({ role: msg.role, content: msg.content });
}

// 计算两个消息数组的最长公共前缀（以消息为单位）
function longestCommonPrefixLen(oldArray, newArray) {
    let i = 0;
    while (i < oldArray.length && i < newArray.length) {
        if (serializeMessage(oldArray[i]) !== serializeMessage(newArray[i])) break;
        i++;
    }
    return i;
}

// ========== 世界书动态剥离 ==========
function optimizeWorldInfo(messages, patterns) {
    if (!Array.isArray(messages)) return messages;
    const regexes = patterns.map(p => new RegExp(p, 'gi'));
    
    return messages.map(msg => {
        if (msg.role !== 'system') return msg;
        
        let dynamicParts = [];
        let cleanedContent = msg.content;
        
        for (const regex of regexes) {
            cleanedContent = cleanedContent.replace(regex, (match) => {
                dynamicParts.push(match);
                return ''; // 移除动态部分
            });
        }
        
        // 清除多余的空行
        cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim();
        
        const result = [{ role: 'system', content: cleanedContent }];
        if (dynamicParts.length > 0) {
            result.push({ role: 'system', content: dynamicParts.join('\n') });
        }
        return result;
    }).flat();
}

// ========== 自适应排序引擎 ==========
function adaptiveSortMessages(newMessages, oldMessages) {
    if (!oldMessages || oldMessages.length === 0) {
        // 没有历史记录，使用默认静态优先排序
        return defaultSort(newMessages);
    }

    // 将新消息分类
    const systemMsgs = newMessages.filter(m => m.role === 'system');
    const nonSystemMsgs = newMessages.filter(m => m.role !== 'system');
    
    // 找到最后一条 user 消息（当前输入），它必须放在最后
    let lastUserIdx = -1;
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        if (nonSystemMsgs[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    const lastUserMsg = lastUserIdx !== -1 ? nonSystemMsgs.splice(lastUserIdx, 1)[0] : null;
    // nonSystemMsgs 现在只剩下历史对话（user/assistant 混合）

    // 对 system 消息分组：能否与旧消息前缀匹配
    const oldSystemMsgs = oldMessages.filter(m => m.role === 'system');
    const staticSystem = [];
    const dynamicSystem = [];

    for (const sysMsg of systemMsgs) {
        // 检测此 system 消息是否在上次存在且位置相同？
        // 简单策略：若内容与旧 system 中某条完全相同，则视为静态，否则动态
        const idx = oldSystemMsgs.findIndex(old => serializeMessage(old) === serializeMessage(sysMsg));
        if (idx !== -1) {
            staticSystem.push({ msg: sysMsg, order: idx });
        } else {
            dynamicSystem.push(sysMsg);
        }
    }

    // 静态 system 按旧数组中出现的顺序排列
    staticSystem.sort((a, b) => a.order - b.order);
    const sortedStaticSystem = staticSystem.map(item => item.msg);
    
    // 最终顺序：静态 system -> 动态 system -> 历史对话 -> 当前用户消息
    const result = [...sortedStaticSystem, ...dynamicSystem, ...nonSystemMsgs];
    if (lastUserMsg) result.push(lastUserMsg);
    
    return result;
}

function defaultSort(messages) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
    
    // 将最后一条 user 放到末尾
    let lastUserIdx = -1;
    for (let i = others.length - 1; i >= 0; i--) {
        if (others[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    const lastUser = lastUserIdx !== -1 ? others.splice(lastUserIdx, 1)[0] : null;
    
    return [...systemMsgs, ...others, lastUser].filter(Boolean);
}

// ========== 缓存前缀分析 ==========
function calculateCachePrefix(optimized, original) {
    const prefixLen = longestCommonPrefixLen(optimized, original);
    const totalOptimized = optimized.length;
    return {
        prefixLength: prefixLen,
        totalLength: totalOptimized,
        cacheablePercent: totalOptimized > 0 ? Math.round((prefixLen / totalOptimized) * 100) : 0
    };
}

// ========== 跨会话评估 ==========
function evaluateCrossSession(systemPrompt) {
    const context = getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];
    if (!settings?.cross_session_eval) return;

    const currentChatId = context.chatMetadata?.chat_id;
    if (!currentChatId) return;

    // 保存当前会话的 system prompt 摘要（前 500 字符哈希）
    const summary = systemPrompt.substring(0, 500).replace(/\s/g, ' ');
    const hash = simpleHash(summary);

    // 检查与已保存会话的相似度
    const profiles = settings.session_profiles || {};
    let bestMatch = { chatId: null, similarity: 0 };

    for (const [chatId, profile] of Object.entries(profiles)) {
        if (chatId === currentChatId) continue;
        const similarity = jaccardSimilarity(summary, profile.summary);
        if (similarity > bestMatch.similarity) {
            bestMatch = { chatId, similarity };
        }
    }

    // 保存当前会话
    profiles[currentChatId] = { summary, hash, timestamp: Date.now() };
    settings.session_profiles = profiles;
    context.saveSettingsDebounced();

    if (bestMatch.similarity > 0.7) {
        debugLog(`跨会话缓存评估：与会话 ${bestMatch.chatId} 的 System Prompt 相似度 ${Math.round(bestMatch.similarity * 100)}%，可复用缓存可能性高`);
    } else if (bestMatch.similarity > 0.4) {
        debugLog(`跨会话缓存评估：与会话 ${bestMatch.chatId} 的 System Prompt 相似度 ${Math.round(bestMatch.similarity * 100)}%，部分缓存可复用`);
    } else {
        debugLog('跨会话缓存评估：未发现高度相似的会话，缓存复用可能性低');
    }
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // 32位整数
    }
    return hash.toString();
}

function jaccardSimilarity(a, b) {
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

// ========== Fetch 拦截 ==========
let originalFetch = null;
let isIntercepting = false;

function patchFetch() {
    if (isIntercepting) return;

    const context = getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];
    if (!settings?.enabled) return;

    originalFetch = window.fetch;
    window.fetch = async function(url, options) {
        const isTargetEndpoint = typeof url === 'string' &&
            (url.includes('/api/backends/chat-completions/generate') || url.includes('/chat/completions'));

        if (isTargetEndpoint && options?.body) {
            try {
                const body = JSON.parse(options.body);
                if (body.messages && Array.isArray(body.messages)) {
                    const currentApi = getCurrentApi();
                    const skip = settings.deepseek_only && !isDeepSeekApi();
                    
                    debugLog(`拦截到生成请求，API: ${currentApi}, 消息数: ${body.messages.length}`, 
                        skip ? '非 DeepSeek，跳过优化' : '开始优化');

                    if (!skip) {
                        let optimizedMessages = deepCopy(body.messages);

                        // 1. 世界书优化
                        if (settings.worldinfo_optimization) {
                            const beforeCount = optimizedMessages.length;
                            optimizedMessages = optimizeWorldInfo(optimizedMessages, settings.dynamic_patterns);
                            debugLog('世界书优化完成', { 原消息数: beforeCount, 新消息数: optimizedMessages.length });
                        }

                        // 2. 自适应排序
                        if (settings.adaptive_sorting) {
                            const oldMsgs = settings.last_sent_messages;
                            optimizedMessages = adaptiveSortMessages(optimizedMessages, oldMsgs);
                            
                            // 计算缓存前缀
                            const cacheInfo = calculateCachePrefix(optimizedMessages, oldMsgs || body.messages);
                            debugLog('自适应排序完成，缓存前缀分析', cacheInfo);
                        } else {
                            optimizedMessages = defaultSort(optimizedMessages);
                        }

                        // 3. 跨会话评估（仅从 system 内容提取）
                        if (settings.cross_session_eval) {
                            const systemContent = optimizedMessages
                                .filter(m => m.role === 'system')
                                .map(m => m.content)
                                .join('\n');
                            evaluateCrossSession(systemContent);
                        }

                        // 更新请求体
                        body.messages = optimizedMessages;
                        options.body = JSON.stringify(body);

                        // 保存本次发送的消息（用于下次对比）
                        settings.last_sent_messages = deepCopy(optimizedMessages);
                        context.saveSettingsDebounced();
                    }
                }
            } catch (e) {
                debugLog('Fetch 拦截处理异常', { error: e.message, stack: e.stack }, true);
            }
        }

        return originalFetch(url, options);
    };
    isIntercepting = true;
    debugLog('Fetch 拦截已激活');
}

function unpatchFetch() {
    if (originalFetch && isIntercepting) {
        window.fetch = originalFetch;
        originalFetch = null;
        isIntercepting = false;
        debugLog('Fetch 拦截已移除');
    }
}

// ========== 事件监听 ==========
function onChatChanged(data) {
    const context = getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];
    if (!settings?.enabled) return;

    // 切换会话时重置 last_sent_messages，因为缓存前缀不再共享
    settings.last_sent_messages = null;
    context.saveSettingsDebounced();
    debugLog('会话已切换，清除上次发送消息缓存');
}

// ========== 生命周期 ==========
export function onActivate() {
    const context = getContext();
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
        context.saveSettingsDebounced();
    }
    
    patchFetch();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    debugLog('扩展已激活，所有优化功能就绪');
}

export function onDeactivate() {
    unpatchFetch();
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    debugLog('扩展已停用');
}
