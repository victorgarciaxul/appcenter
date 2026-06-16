/**
 * xul-tracker.js — XUL AppCenter Usage Tracker v2
 *
 * Cómo añadirlo a cada app (una sola línea al final del <body>):
 *
 *   <script src="https://appcenter.xul.es/xul-tracker.js"
 *           data-app-id="xul-tech"
 *           data-app-name="Xul Tech"></script>
 *
 * IDs por app:
 *   xul-tech | agente-briefing | systems-prompt | giros
 *   deeptalk | crm-xul | mytrack | ecofin | b-corp
 *
 * El tracker detecta automáticamente el usuario logueado desde:
 *   1. Supabase localStorage (sb-*-auth-token) — apps con Supabase
 *   2. xul_tracker_email en localStorage    — para apps con auth custom
 *   3. "anon" si no hay sesión              — briefingXul y similares
 */
(function () {
  const CENTINELA_URL = "https://ojpebdjnpyebvksaofwq.supabase.co";
  const CENTINELA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qcGViZGpucHllYnZrc2FvZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODMxNzgsImV4cCI6MjA5Njk1OTE3OH0.1N9M1Utp_uq3EikRYK3kRtjSUiGzUq1ifNUCaerCKD0";
  const MIN_SECONDS = 10;

  const scriptTag  = document.currentScript || document.querySelector('script[data-app-id]');
  const APP_ID     = scriptTag?.dataset?.appId   || "unknown";
  const APP_NAME   = scriptTag?.dataset?.appName || "Unknown App";

  // ─── User detection ──────────────────────────────────────────────────────
  function getUserFromStorage() {
    // 1. Supabase v2: token may be chunked as sb-*-auth-token.0, .1, ...
    //    or stored as a single sb-*-auth-token key
    const allKeys = [];
    for (let i = 0; i < localStorage.length; i++) allKeys.push(localStorage.key(i));

    // Find all Supabase auth token base keys
    const baseKeys = new Set();
    for (const key of allKeys) {
      if (!key || !key.startsWith("sb-")) continue;
      if (key.endsWith("-auth-token")) baseKeys.add(key);
      const chunkMatch = key.match(/^(sb-.+-auth-token)\.\d+$/);
      if (chunkMatch) baseKeys.add(chunkMatch[1]);
    }

    for (const base of baseKeys) {
      try {
        let raw = localStorage.getItem(base);
        if (!raw) {
          // Reassemble chunked token
          let chunks = "", i = 0;
          while (true) {
            const chunk = localStorage.getItem(`${base}.${i}`);
            if (chunk === null) break;
            chunks += chunk;
            i++;
          }
          raw = chunks || null;
        }
        if (!raw) continue;
        const data = JSON.parse(raw);
        const user = data?.user;
        if (user?.email) {
          return {
            email: user.email,
            name: user.user_metadata?.full_name
               || user.user_metadata?.name
               || user.email.split("@")[0]
          };
        }
      } catch { /* continue */ }
    }
    // 2. MyTrack custom auth
    try {
      const mt = JSON.parse(localStorage.getItem("mytrack-demo-user"));
      if (mt?.email) return { email: mt.email, name: mt.name || mt.email.split("@")[0] };
    } catch {}
    // 3. Giros: sessionStorage['giros_session'] = {email, name, ...}
    try {
      const gs = JSON.parse(sessionStorage.getItem("giros_session"));
      if (gs?.email) return { email: gs.email, name: gs.name || gs.email.split("@")[0] };
    } catch {}
    // 4. Custom auth apps that store email manually (systemprompt, DeepTalk, bcorp, xultech, crm)
    const customEmail = localStorage.getItem("xul_tracker_email");
    if (customEmail) {
      return { email: customEmail, name: customEmail.split("@")[0] };
    }
    // 3. Anonymous
    return { email: "anon@xul.es", name: "Anónimo" };
  }

  // ─── Session state ────────────────────────────────────────────────────────
  let sessionStart     = Date.now();
  let pendingSessionId = null;

  // ─── API ─────────────────────────────────────────────────────────────────
  const HEADERS = {
    "apikey":        CENTINELA_KEY,
    "Authorization": `Bearer ${CENTINELA_KEY}`,
    "Content-Type":  "application/json"
  };

  async function openSession() {
    const user = getUserFromStorage();
    sessionStart     = Date.now();
    pendingSessionId = null;

    try {
      const res = await fetch(`${CENTINELA_URL}/rest/v1/app_sessions`, {
        method:  "POST",
        headers: { ...HEADERS, "Prefer": "return=representation" },
        body: JSON.stringify({
          user_email: user.email,
          user_name:  user.name,
          app_id:     APP_ID,
          app_name:   APP_NAME,
          started_at: new Date(sessionStart).toISOString()
        })
      });
      if (res.ok) {
        const rows = await res.json();
        pendingSessionId = rows?.[0]?.id ?? null;
      }
    } catch { /* silent */ }
  }

  function closeSession() {
    if (!pendingSessionId) return;
    const duration = Math.round((Date.now() - sessionStart) / 1000);
    if (duration < MIN_SECONDS) {
      // Delete stub — too short
      fetch(`${CENTINELA_URL}/rest/v1/app_sessions?id=eq.${pendingSessionId}`, {
        method: "DELETE", headers: HEADERS
      }).catch(() => {});
      pendingSessionId = null;
      return;
    }
    // keepalive works even during beforeunload
    fetch(`${CENTINELA_URL}/rest/v1/app_sessions?id=eq.${pendingSessionId}`, {
      method:   "PATCH",
      headers:  { ...HEADERS, "Prefer": "return=minimal" },
      body:     JSON.stringify({ ended_at: new Date().toISOString(), duration_seconds: duration }),
      keepalive: true
    }).catch(() => {});
    pendingSessionId = null;
  }

  // ─── Lifecycle hooks ─────────────────────────────────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      closeSession();
    } else {
      // Wait briefly for any re-auth on tab re-focus
      setTimeout(openSession, 500);
    }
  });

  window.addEventListener("beforeunload", closeSession);

  // ─── Init ─────────────────────────────────────────────────────────────────
  // Retry until a real user is found (Supabase may restore session async)
  function initWithRetry(attemptsLeft) {
    const user = getUserFromStorage();
    if (user.email !== "anon@xul.es" || attemptsLeft <= 0) {
      openSession();
    } else {
      setTimeout(() => initWithRetry(attemptsLeft - 1), 2000);
    }
  }
  setTimeout(() => initWithRetry(10), 1000); // up to ~21s of retries

  // Expose for debugging: window._xulTracker.status()
  window._xulTracker = {
    APP_ID, APP_NAME,
    status: () => ({ pendingSessionId, sessionStart: new Date(sessionStart).toISOString(), user: getUserFromStorage() })
  };
})();
