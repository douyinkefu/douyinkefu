import { ChatMessage } from '../types';
import { generate20DigitOrderNumber, AGENT_AVATAR, USER_AVATAR } from './orderNumber';
import { generateRandomChineseName, getRandomUserAvatar } from './nameGenerator';

export interface CustomerSession {
  id: string;
  customerName: string;
  customerAvatar: string;
  orderNumber: string;
  createdAt: string;
  lastUpdated: string;
  messages: ChatMessage[];
  unreadCount?: number;
}

const STORAGE_KEY = 'tiktok_refund_sessions_v4';
const CHANNEL_NAME = 'tiktok_refund_session_channel_v4';
const CUSTOMER_SESSION_ID_KEY = 'tiktok_customer_session_id_v4';

// New isolated storage keys to prevent crossover and clearing
const CUSTOMER_SESSION_KEY = 'tiktok_customer_active_session_v4';
const AGENT_SESSIONS_KEY = 'tiktok_agent_sessions_list_v4';

let channel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
}

/**
 * Determine the current web portal role dynamically.
 */
const getIsAgentRole = (): boolean => {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('role') === 'agent' || params.get('role') === 'workbench') return true;
  const pathname = window.location.pathname.toLowerCase();
  return (
    pathname === '/agent' || 
    pathname === '/agent/' || 
    pathname === '/workbench' || 
    pathname === '/workbench/' ||
    pathname.startsWith('/agent/') ||
    pathname.startsWith('/workbench/')
  );
};

/**
 * Robustly merge local and remote messages, avoiding duplicates and maintaining correct sequence.
 */
const mergeMessages = (localMsgs: ChatMessage[], remoteMsgs: ChatMessage[]): ChatMessage[] => {
  const mergedMap = new Map<string, ChatMessage>();
  
  if (Array.isArray(localMsgs)) {
    localMsgs.forEach((msg) => {
      if (msg && msg.id) {
        mergedMap.set(msg.id, msg);
      }
    });
  }

  if (Array.isArray(remoteMsgs)) {
    remoteMsgs.forEach((msg) => {
      if (msg && msg.id) {
        mergedMap.set(msg.id, msg);
      }
    });
  }

  // Sort messages chronologically by extracting the timestamp part of their IDs
  const sorted = Array.from(mergedMap.values()).sort((a, b) => {
    const parseTime = (id: string) => {
      const parts = id.split('_');
      const numPart = parts[parts.length - 1];
      const parsed = parseInt(numPart, 10);
      return isNaN(parsed) ? 0 : parsed;
    };
    return parseTime(a.id) - parseTime(b.id);
  });

  return sorted;
};

/**
 * Get all stored customer sessions sorted by lastUpdated descending.
 */
export const getAllSessions = (): CustomerSession[] => {
  if (typeof window === 'undefined') return [];
  const isAgent = getIsAgentRole();
  const listKey = isAgent ? AGENT_SESSIONS_KEY : STORAGE_KEY;
  
  try {
    let raw = localStorage.getItem(listKey);
    // Fallback to STORAGE_KEY if AGENT_SESSIONS_KEY is empty (backward compatibility)
    if (!raw && isAgent) {
      raw = localStorage.getItem(STORAGE_KEY);
    }
    
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((session) => {
          session.customerAvatar = USER_AVATAR;
          if (session.messages && Array.isArray(session.messages)) {
            session.messages.forEach((msg: ChatMessage) => {
              if (msg.sender === 'agent') {
                msg.agentAvatar = AGENT_AVATAR;
              } else if (msg.sender === 'user') {
                msg.userAvatar = USER_AVATAR;
              }
            });
          }
        });
        return parsed.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
      }
    }
  } catch (e) {
    console.error('Failed to parse sessions:', e);
  }
  return [];
};

/**
 * Save all sessions to localStorage, broadcast, and sync to Express API.
 */
export const saveAndBroadcastSessions = async (sessions: CustomerSession[]) => {
  if (typeof window === 'undefined') return;
  const isAgent = getIsAgentRole();
  const listKey = isAgent ? AGENT_SESSIONS_KEY : STORAGE_KEY;
  
  try {
    localStorage.setItem(listKey, JSON.stringify(sessions));
    if (!isAgent) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    }
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }

  if (channel) {
    try {
      channel.postMessage({ type: 'SYNC_SESSIONS', payload: sessions });
    } catch (e) {
      console.error('BroadcastChannel post error:', e);
    }
  }

  window.dispatchEvent(new CustomEvent('tiktok_sessions_updated', { detail: sessions }));

  // Non-blocking upload to Express API
  for (const s of sessions) {
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s)
    }).catch((err) => {
      console.error('Failed to sync session to Express API:', err);
    });
  }
};

/**
 * Get active customer session or create one.
 */
export const getOrCreateCustomerSession = (): CustomerSession => {
  const nowStr = new Date().toISOString();
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const currentHHMM = `${hours}:${minutes}`;

  if (typeof window === 'undefined') {
    return {
      id: 'ssr_session',
      customerName: '退款咨询用户',
      customerAvatar: USER_AVATAR,
      orderNumber: generate20DigitOrderNumber(),
      createdAt: nowStr,
      lastUpdated: nowStr,
      messages: [],
    };
  }

  // 1. Try dedicated customer key
  const storedActive = localStorage.getItem(CUSTOMER_SESSION_KEY);
  if (storedActive) {
    try {
      const parsed = JSON.parse(storedActive);
      if (parsed && typeof parsed === 'object' && parsed.id) {
        parsed.customerAvatar = USER_AVATAR;
        if (parsed.messages) {
          parsed.messages.forEach((msg: ChatMessage) => {
            if (msg.sender === 'agent') msg.agentAvatar = AGENT_AVATAR;
            if (msg.sender === 'user') msg.userAvatar = USER_AVATAR;
          });
        }
        return parsed;
      }
    } catch (e) {
      console.error('Error parsing stored active customer session:', e);
    }
  }

  // 2. Fallback to list key
  const existingId = localStorage.getItem(CUSTOMER_SESSION_ID_KEY);
  if (existingId) {
    const sessions = getAllSessions();
    const foundInList = sessions.find((s) => s.id === existingId);
    if (foundInList) {
      foundInList.customerAvatar = USER_AVATAR;
      localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(foundInList));
      return foundInList;
    }
  }

  // 3. Create brand new session
  const newId = existingId || `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  localStorage.setItem(CUSTOMER_SESSION_ID_KEY, newId);

  const newOrderNumber = generate20DigitOrderNumber();
  const newName = generateRandomChineseName();
  const newAvatar = getRandomUserAvatar();

  const initialMessage: ChatMessage = {
    id: `init_${Date.now()}`,
    sender: 'agent',
    agentName: '官方客服-小林',
    agentAvatar: AGENT_AVATAR,
    text: `您好，我是抖音官方服务专家小林，很高兴为您服务。`,
    timestamp: currentHHMM,
  };

  const newSession: CustomerSession = {
    id: newId,
    customerName: newName,
    customerAvatar: newAvatar,
    orderNumber: newOrderNumber,
    createdAt: nowStr,
    lastUpdated: nowStr,
    messages: [initialMessage],
    unreadCount: 0,
  };

  localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(newSession));
  
  const sessions = getAllSessions();
  const index = sessions.findIndex((s) => s.id === newId);
  if (index !== -1) {
    sessions[index] = newSession;
  } else {
    sessions.unshift(newSession);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));

  window.dispatchEvent(new CustomEvent('tiktok_sessions_updated', { detail: sessions }));

  // Upload to Express API
  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newSession)
  }).catch((err) => {
    console.error('Failed to create new session in Express API:', err);
  });

  return newSession;
};

/**
 * Update messages for a specific session directly to API and LocalStorage.
 */
export const updateSessionMessages = async (
  sessionId: string,
  updater: (prevMsgs: ChatMessage[]) => ChatMessage[]
) => {
  if (typeof window === 'undefined') return;

  const isAgent = getIsAgentRole();
  const mySessionId = localStorage.getItem(CUSTOMER_SESSION_ID_KEY);
  const isMySession = sessionId === mySessionId;

  let currentSession: CustomerSession | null = null;

  // If this is the active customer's own session, load from dedicated key
  if (isMySession) {
    const raw = localStorage.getItem(CUSTOMER_SESSION_KEY);
    if (raw) {
      try {
        currentSession = JSON.parse(raw);
      } catch {}
    }
  }

  // Fallback to loading from list
  if (!currentSession) {
    const sessions = getAllSessions();
    currentSession = sessions.find((s) => s.id === sessionId) || null;
  }

  // Fallback to remote API fetch
  if (!currentSession) {
    try {
      const res = await fetch(`/api/sessions?id=${sessionId}`);
      if (res.ok) {
        currentSession = await res.json();
      }
    } catch (err) {
      console.error('Error fetching session from Express API:', err);
    }
  }

  // Create empty placeholder if absolutely not found
  if (!currentSession) {
    const nowStr = new Date().toISOString();
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const currentHHMM = `${hours}:${minutes}`;

    currentSession = {
      id: sessionId,
      customerName: generateRandomChineseName(),
      customerAvatar: USER_AVATAR,
      orderNumber: generate20DigitOrderNumber(),
      createdAt: nowStr,
      lastUpdated: nowStr,
      messages: [{
        id: `init_${Date.now()}`,
        sender: 'agent',
        agentName: '官方客服-小林',
        agentAvatar: AGENT_AVATAR,
        text: `您好，我是抖音官方服务专家小林，很高兴为您服务。`,
        timestamp: currentHHMM,
      }],
      unreadCount: 0,
    };
  }

  const prevMsgs = currentSession.messages || [];
  const nextMsgs = updater(prevMsgs);
  const nowStr = new Date().toISOString();

  const updatedSession = {
    ...currentSession,
    messages: nextMsgs,
    lastUpdated: nowStr,
  };

  // Save to active customer key if applicable
  if (isMySession) {
    localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(updatedSession));
  }

  // Save to list key
  const listKey = isAgent ? AGENT_SESSIONS_KEY : STORAGE_KEY;
  let sessions = getAllSessions();
  
  const index = sessions.findIndex((s) => s.id === sessionId);
  if (index !== -1) {
    sessions[index] = updatedSession;
  } else {
    sessions.unshift(updatedSession);
  }
  sessions.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
  
  localStorage.setItem(listKey, JSON.stringify(sessions));

  if (!isAgent) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }

  window.dispatchEvent(new CustomEvent('tiktok_sessions_updated', { detail: sessions }));

  // Save to Express API asynchronously
  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedSession)
  }).catch((err) => {
    console.error('Failed to save updated messages to Express API:', err);
  });
};

/**
 * Delete a session by ID.
 */
export const deleteSession = async (sessionId: string) => {
  if (typeof window === 'undefined') return;

  // Delete from Express API
  try {
    await fetch(`/api/sessions?id=${sessionId}`, {
      method: 'DELETE'
    });
  } catch (err) {
    console.error('Failed to delete session from Express API:', err);
  }

  const isAgent = getIsAgentRole();
  const listKey = isAgent ? AGENT_SESSIONS_KEY : STORAGE_KEY;

  const sessions = getAllSessions();
  const filtered = sessions.filter((s) => s.id !== sessionId);
  localStorage.setItem(listKey, JSON.stringify(filtered));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));

  const mySessionId = localStorage.getItem(CUSTOMER_SESSION_ID_KEY);
  if (sessionId === mySessionId) {
    localStorage.removeItem(CUSTOMER_SESSION_KEY);
    localStorage.removeItem(CUSTOMER_SESSION_ID_KEY);
  }

  window.dispatchEvent(new CustomEvent('tiktok_sessions_updated', { detail: filtered }));
};

/**
 * Subscribe to session changes across windows/tabs/devices using HTTP polling.
 */
export const subscribeSessions = (onSync: (sessions: CustomerSession[]) => void) => {
  if (typeof window === 'undefined') return () => {};

  let isStopped = false;
  const isAgent = getIsAgentRole();
  const mySessionId = localStorage.getItem(CUSTOMER_SESSION_ID_KEY);

  const pollSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (res.ok && !isStopped) {
        const remoteSessions: CustomerSession[] = await res.json();
        if (!Array.isArray(remoteSessions)) return;

        // Normalize avatars
        remoteSessions.forEach((session) => {
          session.customerAvatar = USER_AVATAR;
          if (session.messages && Array.isArray(session.messages)) {
            session.messages.forEach((msg: ChatMessage) => {
              if (msg.sender === 'agent') {
                msg.agentAvatar = AGENT_AVATAR;
              } else if (msg.sender === 'user') {
                msg.userAvatar = USER_AVATAR;
              }
            });
          }
        });

        // Customer portal: verify and heal local session
        if (!isAgent && mySessionId) {
          const remoteMine = remoteSessions.find((s) => s.id === mySessionId);
          let localMine: CustomerSession | null = null;
          
          try {
            const raw = localStorage.getItem(CUSTOMER_SESSION_KEY);
            if (raw) localMine = JSON.parse(raw);
          } catch {}

          if (remoteMine) {
            // Merge local and remote messages so we never lose messages or suffer latency issues
            const mergedMsgs = mergeMessages(localMine?.messages || [], remoteMine.messages || []);
            const updatedMine = {
              ...remoteMine,
              messages: mergedMsgs,
              lastUpdated: new Date().toISOString()
            };

            // Save back to local dedicated storage
            localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(updatedMine));

            // Replace in the list
            const idx = remoteSessions.findIndex((s) => s.id === mySessionId);
            if (idx !== -1) {
              remoteSessions[idx] = updatedMine;
            }

            // If we have more messages locally, push them back to the server
            if (mergedMsgs.length > (remoteMine.messages?.length || 0)) {
              fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedMine)
              }).catch(() => {});
            }
          } else {
            // Self-healing: if server has lost our session, restore it using our complete history!
            if (localMine && localMine.customerName !== '退款咨询用户') {
              fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(localMine)
              }).catch(() => {});
              remoteSessions.unshift(localMine);
            } else {
              // Recreate if no valid history exists
              const nowStr = new Date().toISOString();
              const now = new Date();
              const hours = now.getHours().toString().padStart(2, '0');
              const minutes = now.getMinutes().toString().padStart(2, '0');
              const currentHHMM = `${hours}:${minutes}`;

              const newSession: CustomerSession = {
                id: mySessionId,
                customerName: generateRandomChineseName(),
                customerAvatar: USER_AVATAR,
                orderNumber: generate20DigitOrderNumber(),
                createdAt: nowStr,
                lastUpdated: nowStr,
                messages: [{
                  id: `init_${Date.now()}`,
                  sender: 'agent',
                  agentName: '官方客服-小林',
                  agentAvatar: AGENT_AVATAR,
                  text: `您好，我是抖音官方服务专家小林，很高兴为您服务。`,
                  timestamp: currentHHMM,
                }],
                unreadCount: 0,
              };

              localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify(newSession));
              fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newSession)
              }).catch(() => {});

              remoteSessions.unshift(newSession);
            }
          }
        }

        // Sort by lastUpdated descending
        remoteSessions.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());

        // Save list under appropriate isolated role key
        try {
          if (isAgent) {
            localStorage.setItem(AGENT_SESSIONS_KEY, JSON.stringify(remoteSessions));
          } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteSessions));
          }
        } catch {}

        if (!isStopped) {
          onSync(remoteSessions);
        }
      }
    } catch (err) {
      console.warn('API polling fetch failed (normal if offline or server restarting):', err);
    }
  };

  pollSessions();
  const intervalId = setInterval(pollSessions, 2000);

  const handleBroadcast = (event: MessageEvent) => {
    if (event.data && event.data.type === 'SYNC_SESSIONS' && Array.isArray(event.data.payload)) {
      onSync(event.data.payload);
    }
  };

  if (channel) {
    channel.addEventListener('message', handleBroadcast);
  }

  const handleStorage = (e: StorageEvent) => {
    const listKey = isAgent ? AGENT_SESSIONS_KEY : STORAGE_KEY;
    if (e.key === listKey && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          onSync(parsed);
        }
      } catch {}
    }
  };

  const handleLocalUpdate = (e: Event) => {
    const customEvent = e as CustomEvent<CustomerSession[]>;
    if (customEvent.detail && Array.isArray(customEvent.detail)) {
      onSync(customEvent.detail);
    }
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener('tiktok_sessions_updated', handleLocalUpdate);

  return () => {
    isStopped = true;
    clearInterval(intervalId);
    if (channel) {
      channel.removeEventListener('message', handleBroadcast);
    }
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener('tiktok_sessions_updated', handleLocalUpdate);
  };
};
