// DeepSeek Cache Optimizer v2.0 - Corrected for SillyTavern environment
const EXTENSION_NAME = 'DeepSeekCacheOptimizer';

// 获取 context 和全局变量
const context = SillyTavern.getContext();
const eventSource = context.eventSource;
const saveSettingsDebounced = context.saveSettingsDebounced.bind(context);
// event_types 是全局常量
// extension_settings 是全局变量

const DEFAULT_SETTINGS = {
    enabled: true,
    debug_enabled: true,
    adaptive_sorting: true,
    worldinfo_optimization: true,
    cross_session_eval: true,
    deepseek_only: true,
    dynamic_patterns: [
        '\\(概率[^)]*\\)',
        '\\(触发[^)]*\\)',
        '\\(已触发[^)]*\\)',
        '\\(持续[^)]*\\)',
        '\\(剩余[^)]*\\)',
        '\\[动态\\].*?\\[/动态\\]'
    ],
    last_sent_messages: null,
    session_profiles: {}
};

// ---------- Debug Logger ----------
function debugLog(message, data = null, isError = false) {
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.debug_enabled) return;
    const prefix = `[${EXTENSION_NAME}]`;
    if (isError) {
        console.error(`${prefix} ❌ ${message}`, data || '');
        if (typeof toastr !== 'undefined') toastr.error(message);
    } else {
        console.log(`${prefix} ✅ ${message}`, data || '');
    }
}

// ---------- Utility ----------
function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function serializeMessage(msg) {
    return JSON.stringify({ role: msg.role, content: msg.content });
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
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

// ---------- API Detection ----------
function isDeepSeekApi() {
    // 尝试从 power_user 获取当前 API 名称
    if (typeof power_user !== 'undefined' && power_user.api) {
        return power_user.api.toLowerCase().includes('deepseek');
    }
    // 如果 power_user 不可用，默认允许优化（用户可关闭开关）
    return true;
}

// ---------- World Info Optimization ----------
function optimizeWorldInfo(messages, patterns) {
    if (!Array.isArray(messages)) return messages;
    const regexes = patterns.map(p => new RegExp(p, 'gi'));
    return messages.flatMap(msg => {
        if (msg.role !== 'system') return msg;
        let dynamicParts = [];
        let cleaned = msg.content;
        regexes.forEach(re => {
            cleaned = cleaned.replace(re, match => {
                dynamicParts.push(match);
                return '';
            });
        });
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
        const result = [{ role: 'system', content: cleaned }];
        if (dynamicParts.length) {
            result.push({ role: 'system', content: dynamicParts.join('\n') });
        }
        return result;
    });
}

// ---------- Adaptive Sorting ----------
function longestCommonPrefixLen(oldArr, newArr) {
    let i = 0;
    while (i < oldArr.length && i < newArr.length) {
        if (serializeMessage(oldArr[i]) !== serializeMessage(newArr[i])) break;
        i++;
    }
    return i;
}

function defaultSort(messages) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const others = messages.filter(m => m.role !== 'system');
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

function adaptiveSortMessages(newMessages, oldMessages) {
    if (!oldMessages?.length) return defaultSort(newMessages);
    const systemMsgs = newMessages.filter(m => m.role === 'system');
    const nonSystemMsgs = newMessages.filter(m => m.role !== 'system');
    let lastUserIdx = -1;
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        if (nonSystemMsgs[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    const lastUserMsg = lastUserIdx !== -1 ? nonSystemMsgs.splice(lastUserIdx, 1)[0] : null;
    const oldSystemMsgs = oldMessages.filter(m => m.role === 'system');
    const staticSystem = [], dynamicSystem = [];
    systemMsgs.forEach(msg => {
        const idx = oldSystemMsgs.findIndex(old => serializeMessage(old) === serializeMessage(msg));
        if (idx !== -1) staticSystem.push({ msg, order: idx });
        else dynamicSystem.push(msg);
    });
    staticSystem.sort((a, b) => a.order - b.order);
    return [...staticSystem.map(x => x.msg), ...dynamicSystem, ...nonSystemMsgs, lastUserMsg].filter(Boolean);
}

// ---------- Cache Analysis ----------
function calculateCachePrefix(optimized, original) {
    const prefixLen = longestCommonPrefixLen(optimized, original);
    return {
        prefixLength: prefixLen,
        totalLength: optimized.length,
        cacheablePercent: optimized.length > 0 ? Math.round((prefixLen / optimized.length) * 100) : 0
    };
}

// ---------- Cross-Session Evaluation ----------
function evaluateCrossSession(systemContent) {
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.cross_session_eval) return;
    const chatId = context.chatMetadata?.chat_id;
    if (!chatId) return;
    const summary = systemContent.substring(0, 500).replace(/\s/g, ' ');
    const hash = simpleHash(summary);
    const profiles = settings.session_profiles || {};
    let bestMatch = { chatId: null, similarity: 0 };
    for (const [id, profile] of Object.entries(profiles)) {
        if (id === chatId) continue;
        const sim = jaccardSimilarity(summary, profile.summary);
        if (sim > bestMatch.similarity) bestMatch = { chatId: id, similarity: sim };
    }
    profiles[chatId] = { summary, hash, timestamp: Date.now() };
    settings.session_profiles = profiles;
    saveSettingsDebounced();
    if (bestMatch.similarity > 0.7) {
        debugLog(`Cross-session: high similarity (${Math.round(bestMatch.similarity*100)}%) with chat ${bestMatch.chatId}, cache reuse likely`);
    } else if (bestMatch.similarity > 0.4) {
        debugLog(`Cross-session: partial similarity (${Math.round(bestMatch.similarity*100)}%) with chat ${bestMatch.chatId}`);
    } else {
        debugLog('Cross-session: no similar sessions found');
    }
}

// ---------- Fetch Interception ----------
let originalFetch = null;
let isActive = false;

function patchFetch() {
    if (isActive) return;
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.enabled) return;
    originalFetch = window.fetch;
    window.fetch = async function(url, options) {
        const urlStr = typeof url === 'string' ? url : url.url;
        const isTarget = urlStr && (urlStr.includes('/api/backends/chat-completions/generate') || urlStr.includes('/chat/completions'));
        if (isTarget && options?.body) {
            try {
                const body = JSON.parse(options.body);
                if (body.messages && Array.isArray(body.messages)) {
                    const skip = settings.deepseek_only && !isDeepSeekApi();
                    debugLog(`Fetch intercepted. Skip: ${skip}`);
                    if (!skip) {
                        let optimized = deepCopy(body.messages);
                        if (settings.worldinfo_optimization) {
                            optimized = optimizeWorldInfo(optimized, settings.dynamic_patterns);
                            debugLog('World info optimized');
                        }
                        if (settings.adaptive_sorting) {
                            const old = settings.last_sent_messages;
                            optimized = adaptiveSortMessages(optimized, old);
                            debugLog('Adaptive sorting applied', calculateCachePrefix(optimized, old || body.messages));
                        } else {
                            optimized = defaultSort(optimized);
                        }
                        if (settings.cross_session_eval) {
                            const systemContent = optimized.filter(m => m.role === 'system').map(m => m.content).join('\n');
                            evaluateCrossSession(systemContent);
                        }
                        body.messages = optimized;
                        options.body = JSON.stringify(body);
                        settings.last_sent_messages = deepCopy(optimized);
                        saveSettingsDebounced();
                    }
                }
            } catch (e) {
                debugLog('Fetch interception error', e, true);
            }
        }
        return originalFetch(url, options);
    };
    isActive = true;
    debugLog('Fetch interception activated');
}

function unpatchFetch() {
    if (originalFetch && isActive) {
        window.fetch = originalFetch;
        originalFetch = null;
        isActive = false;
        debugLog('Fetch interception removed');
    }
}

// ---------- Event Handlers ----------
function onChatChanged() {
    const settings = extension_settings[EXTENSION_NAME];
    if (settings?.enabled) {
        settings.last_sent_messages = null;
        saveSettingsDebounced();
        debugLog('Chat changed, reset last sent messages');
    }
}

// ---------- Lifecycle Hooks ----------
window.onActivate = function() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
        saveSettingsDebounced();
    }
    patchFetch();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    debugLog('Extension activated');
};

window.onDeactivate = function() {
    unpatchFetch();
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    debugLog('Extension deactivated');
};
