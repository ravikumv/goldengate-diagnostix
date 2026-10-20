import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getAdditionalUserInfo, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, updateProfile, signOut, reload,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAnalytics, isSupported, logEvent } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import { firebaseConfig } from "/firebase-config.js";

/* ============ Setup ============ */
const API_BASE = "";
const MAX_CHARS = 60000;

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const views = { boot: $("boot"), auth: $("authView"), verify: $("verifyView"), app: $("appView") };
function show(name) { for (const k in views) views[k].hidden = k !== name; }

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE")) {
  views.boot.textContent = "Firebase is not configured yet. Edit public/firebase-config.js with your Firebase web app config.";
  throw new Error("Firebase config missing");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let analytics = null;
isSupported().then((ok) => { if (ok && firebaseConfig.measurementId && !firebaseConfig.measurementId.startsWith("G-XXXX")) analytics = getAnalytics(app); }).catch(() => {});
function track(name, params) { try { if (analytics) logEvent(analytics, name, params); } catch { /* ignore */ } }

/* ============ State ============ */
let user = null;
let profile = { displayName: "", photoDataUrl: "" };
let messages = [];
let busy = false;
let pendingName = null;

/* ============ Auth UI ============ */
let mode = "signin";
const authErr = $("authErr"), authInfo = $("authInfo");

function setMode(m) {
  mode = m;
  const up = m === "signup";
  $("authTitle").textContent = up ? "Create your account" : "Sign in";
  $("authSub").textContent = up ? "Free. Takes under a minute." : "Continue to your GoldenGate assistant.";
  $("nameField").hidden = !up;
  $("authSubmit").textContent = up ? "Create account" : "Sign in";
  $("modeBtn").textContent = up ? "I already have an account" : "Create an account";
  $("forgotBtn").hidden = up;
  $("passIn").autocomplete = up ? "new-password" : "current-password";
  clearAuthMsgs();
}
function clearAuthMsgs() { authErr.hidden = true; authInfo.hidden = true; }
function showAuthErr(t) { authInfo.hidden = true; authErr.textContent = t; authErr.hidden = false; }
function showAuthInfo(t) { authErr.hidden = true; authInfo.textContent = t; authInfo.hidden = false; }
function setAuthBusy(b) { $("authSubmit").disabled = b; $("googleBtn").disabled = b; }

function friendly(err) {
  const map = {
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/missing-password": "Enter your password.",
    "auth/weak-password": "Use a password of at least 8 characters.",
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "auth/unauthorized-domain": "This domain isn't authorized in Firebase. Add it under Authentication > Settings > Authorized domains.",
    "auth/operation-not-allowed": "This sign-in method isn't enabled in Firebase yet.",
    "app/name": "Enter your name.",
  };
  return map[err?.code] || "Something went wrong. Please try again.";
}

$("modeBtn").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthMsgs();
  const email = $("emailIn").value.trim(), pass = $("passIn").value, name = $("nameIn").value.trim();
  if (!email) return showAuthErr(friendly({ code: "auth/invalid-email" }));
  if (!pass) return showAuthErr(friendly({ code: "auth/missing-password" }));
  setAuthBusy(true);
  try {
    if (mode === "signup") {
      if (!name) throw { code: "app/name" };
      if (pass.length < 8) throw { code: "auth/weak-password" };
      pendingName = name;
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      await sendEmailVerification(cred.user);
      track("sign_up", { method: "password" });
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
      track("login", { method: "password" });
    }
  } catch (err) {
    pendingName = null;
    showAuthErr(friendly(err));
  } finally { setAuthBusy(false); }
});

$("googleBtn").addEventListener("click", async () => {
  clearAuthMsgs(); setAuthBusy(true);
  const provider = new GoogleAuthProvider();
  try {
    const r = await signInWithPopup(auth, provider);
    track(getAdditionalUserInfo(r)?.isNewUser ? "sign_up" : "login", { method: "google" });
  } catch (err) {
    if (err.code === "auth/popup-blocked") {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { showAuthErr(friendly(e2)); }
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      showAuthErr(friendly(err));
    }
  } finally { setAuthBusy(false); }
});

$("forgotBtn").addEventListener("click", async () => {
  clearAuthMsgs();
  const email = $("emailIn").value.trim();
  if (!email) return showAuthErr("Enter your email above, then click Forgot password.");
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (err) {
    if (err.code !== "auth/user-not-found") return showAuthErr(friendly(err));
  }
  showAuthInfo("If an account exists for that email, a reset link is on its way.");
});

/* ---- Verify view ---- */
const verifyMsg = $("verifyMsg");
$("verifiedBtn").addEventListener("click", async () => {
  verifyMsg.hidden = true;
  try {
    await reload(user);
    if (user.emailVerified) { await user.getIdToken(true); enterApp(); }
    else { verifyMsg.className = "note err"; verifyMsg.textContent = "Not verified yet. Open the link in the email first."; verifyMsg.hidden = false; }
  } catch (err) { verifyMsg.className = "note err"; verifyMsg.textContent = friendly(err); verifyMsg.hidden = false; }
});
$("resendBtn").addEventListener("click", async () => {
  try {
    await sendEmailVerification(user);
    verifyMsg.className = "note ok"; verifyMsg.textContent = "Verification email sent. Check spam if it doesn't arrive.";
  } catch (err) { verifyMsg.className = "note err"; verifyMsg.textContent = friendly(err); }
  verifyMsg.hidden = false;
});
$("verifyOutBtn").addEventListener("click", () => signOut(auth));

/* ============ User document (Firestore) ============ */
const inflight = new Map();
function ensureUserDoc(u) {
  if (inflight.has(u.uid)) return inflight.get(u.uid);
  const p = (async () => {
    const ref = doc(db, "users", u.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const name = (pendingName || u.displayName || (u.email || "").split("@")[0] || "User").slice(0, 80);
      const data = {
        displayName: name, email: u.email || "", photoDataUrl: "",
        provider: u.providerData[0]?.providerId || "password",
        createdAt: serverTimestamp(), lastLoginAt: serverTimestamp(), lastActiveAt: serverTimestamp(),
        messageCount: 0,
      };
      await setDoc(ref, data);
      pendingName = null;
      return { displayName: name, photoDataUrl: "" };
    }
    await updateDoc(ref, { lastLoginAt: serverTimestamp(), lastActiveAt: serverTimestamp() });
    return snap.data();
  })();
  inflight.set(u.uid, p);
  p.finally(() => setTimeout(() => inflight.delete(u.uid), 3000));
  return p;
}

onAuthStateChanged(auth, async (u) => {
  user = u;
  if (!u) { messages = []; busy = false; show("auth"); return; }
  try { profile = await ensureUserDoc(u); }
  catch (e) { console.error(e); profile = { displayName: u.displayName || "", photoDataUrl: "" }; }
  if (!u.emailVerified) { $("verifyEmail").textContent = u.email; show("verify"); return; }
  enterApp();
});

/* ============ Avatar / Profile ============ */
function fillAvatar(node) {
  node.replaceChildren();
  const src = profile.photoDataUrl || user?.photoURL;
  if (src) {
    const img = document.createElement("img");
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.src = src;
    img.addEventListener("error", () => { node.replaceChildren(document.createTextNode(initials())); });
    node.appendChild(img);
  } else node.textContent = initials();
}
function initials() {
  const n = (profile.displayName || user?.displayName || user?.email || "?").trim();
  const parts = n.split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

const dlg = $("profileDlg");
const profErr = $("profErr"), profOk = $("profOk");
function profMsg(kind, t) { profErr.hidden = profOk.hidden = true; const n = kind === "err" ? profErr : profOk; n.textContent = t; n.hidden = false; }

$("avatarBtn").addEventListener("click", () => {
  profErr.hidden = profOk.hidden = true;
  $("profName").value = profile.displayName || user.displayName || "";
  $("profMeta").textContent = `${user.email} · signed in with ${user.providerData[0]?.providerId === "google.com" ? "Google" : "email"}`;
  fillAvatar($("profAvatar"));
  dlg.showModal();
});
$("profClose").addEventListener("click", () => dlg.close());
$("signOutBtn").addEventListener("click", async () => { dlg.close(); await signOut(auth); });

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("profName").value.trim();
  if (!name) return profMsg("err", "Enter a name.");
  try {
    await updateDoc(doc(db, "users", user.uid), { displayName: name });
    await updateProfile(user, { displayName: name });
    profile.displayName = name;
    fillAvatar($("avatarBtn")); fillAvatar($("profAvatar"));
    profMsg("ok", "Saved.");
  } catch (err) { console.error(err); profMsg("err", "Couldn't save. Try again."); }
});

// Resize to a 256x256 square JPEG so it stays small enough to store in Firestore (free, no Storage plan needed).
async function toSquareJpeg(file, size = 256) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  c.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  bmp.close?.();
  return c.toDataURL("image/jpeg", 0.82);
}
async function savePhoto(dataUrl) {
  await updateDoc(doc(db, "users", user.uid), { photoDataUrl: dataUrl });
  profile.photoDataUrl = dataUrl;
  fillAvatar($("avatarBtn")); fillAvatar($("profAvatar"));
}
$("photoBtn").addEventListener("click", () => $("photoIn").click());
$("photoIn").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) return profMsg("err", "Choose an image file.");
  if (f.size > 10 * 1024 * 1024) return profMsg("err", "Image is too large. Choose one under 10 MB.");
  try { await savePhoto(await toSquareJpeg(f)); profMsg("ok", "Photo updated."); }
  catch (err) { console.error(err); profMsg("err", "Couldn't use that image. Try a JPG or PNG."); }
});
$("photoRemoveBtn").addEventListener("click", async () => {
  try { await savePhoto(""); profMsg("ok", "Photo removed."); } catch { profMsg("err", "Couldn't remove the photo."); }
});

/* ============ Chat ============ */
const thread = $("thread"), scroller = $("scroller"), input = $("input"), sendBtn = $("sendBtn");
const errorBar = $("errorBar"), errorMsg = $("errorMsg"), counter = $("counter");
const storeKey = () => `ggdx.chat.v2.${user.uid}`;
function persist() { if (user) store.set(storeKey(), JSON.stringify(messages.slice(-40))); }

const SAMPLE = `2026-10-18 02:14:07  ERROR   OGG-01296  Oracle GoldenGate Delivery for Oracle, RORDERS.prm:  Error mapping from HR.ORDER_ITEMS to HR.ORDER_ITEMS.
2026-10-18 02:14:07  WARNING OGG-01004  Oracle GoldenGate Delivery for Oracle, RORDERS.prm:  Aborted grouped transaction on 'HR.ORDER_ITEMS', Mapping error.
OCI Error ORA-01403: no data found, SQL <UPDATE "HR"."ORDER_ITEMS" SET "STATUS" = :a1 WHERE "ORDER_ID" = :b0 AND "LINE_NO" = :b1>
REPLICAT RORDERS  Lag at Chkpt 01:42:18   Time Since Chkpt 00:00:02
EXTRACT EORDERS   Lag at Chkpt 00:00:03
CACHEMGR virtual memory values (may have been adjusted): CACHESIZE 64G, CACHEBUFFERSIZE 256K, Total disk space used by swap files: 41.2G
Source table HR.ORDER_ITEMS has no supplemental log group; target table has no index on (ORDER_ID, LINE_NO).`;

marked.setOptions({ gfm: true, breaks: false });

function enterApp() {
  let saved = [];
  try { saved = JSON.parse(store.get(storeKey()) || "[]"); } catch { saved = []; }
  messages = Array.isArray(saved) ? saved : [];
  fillAvatar($("avatarBtn"));
  hideError();
  show("app");
  render(); refreshControls();
}

function impactOf(md) {
  const i = md.search(/impact level/i);
  if (i < 0) return null;
  const m = md.slice(i, i + 250).match(/CRITICAL|HIGH|MEDIUM|LOW/i);
  return m ? m[0].toUpperCase() : null;
}

function userMsg(m) {
  const wrap = el("div", "msg user"), bubble = el("div", "bubble");
  const long = m.content.length > 700 || m.content.split("\n").length > 10;
  if (!long) bubble.appendChild(el("p", "plain", m.content));
  else {
    const label = `Show full message (${m.content.length.toLocaleString()} chars)`;
    const pre = el("pre", "logblock", m.content);
    const tog = el("button", "linkbtn", label); tog.type = "button";
    tog.addEventListener("click", () => { const open = pre.classList.toggle("open"); tog.textContent = open ? "Collapse" : label; });
    bubble.append(pre, tog);
  }
  wrap.appendChild(bubble);
  return wrap;
}

function botMsg(m) {
  const wrap = el("div", "msg bot");
  const level = impactOf(m.content);
  if (level) wrap.appendChild(el("span", `chip ${level}`, `${level} impact`));
  const bubble = el("div", "bubble md");
  bubble.innerHTML = DOMPurify.sanitize(marked.parse(m.content));
  const tools = el("div", "tools");
  const copy = el("button", "linkbtn", "Copy"); copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(m.content); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  tools.appendChild(copy);
  wrap.append(bubble, tools);
  return wrap;
}

function welcome() {
  const first = (profile.displayName || user?.displayName || "").split(" ")[0];
  const w = el("section", "welcome");
  w.append(el("h2", null, first ? `${first}, paste a log.` : "Paste a log. Get a diagnosis."),
    el("p", null, "Drop in ggserr.log lines, a process report, discard file entries or a parameter file. I'll identify the process, the root cause, the impact and the fix, then you can keep asking."));
  const ul = el("ul", "starters");
  const items = [
    ["Try a sample Replicat failure", "Loads an example log into the message box", () => { input.value = SAMPLE; autosize(); input.focus(); }],
    ["Why is my Replicat lagging?", "Common causes and what to check first", () => send("Why is my Replicat lagging? List the most common causes and what to check first.")],
    ["What supplemental logging does Extract need?", "Database-level and table-level requirements", () => send("What supplemental logging does an Oracle Extract need, at database level and table level?")],
  ];
  for (const [title, sub, fn] of items) {
    const li = el("li"), b = el("button"); b.type = "button";
    b.append(document.createTextNode(title), el("small", null, sub));
    b.addEventListener("click", fn);
    li.appendChild(b); ul.appendChild(li);
  }
  w.appendChild(ul);
  return w;
}

function typing() {
  const t = el("div", "typing"); t.setAttribute("aria-label", "Analyzing");
  t.append(el("i"), el("i"), el("i"));
  return t;
}

function render() {
  thread.replaceChildren();
  if (!messages.length && !busy) thread.appendChild(welcome());
  for (const m of messages) thread.appendChild(m.role === "user" ? userMsg(m) : botMsg(m));
  if (busy) thread.appendChild(typing());
  scroller.scrollTop = scroller.scrollHeight;
}

function showError(msg) { errorMsg.textContent = msg; errorBar.hidden = false; }
function hideError() { errorBar.hidden = true; }

function refreshControls() {
  const n = input.value.length;
  sendBtn.disabled = busy || !input.value.trim() || n > MAX_CHARS;
  counter.textContent = n > 50000 ? `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}` : "";
  counter.style.color = n > MAX_CHARS ? "#B3261E" : "";
}
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  refreshControls();
}

async function callApi(retry = true) {
  const token = await user.getIdToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: messages.slice(-20) }),
      signal: ctrl.signal,
    });
    if (res.status === 401 && retry) { await user.getIdToken(true); return callApi(false); }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
    if (!data.reply) throw new Error("Empty response from server.");
    return data.reply;
  } finally { clearTimeout(timer); }
}

async function ask() {
  busy = true; refreshControls(); render();
  try {
    const reply = await callApi();
    messages.push({ role: "assistant", content: reply });
    persist();
    track("chat_message");
    updateDoc(doc(db, "users", user.uid), { messageCount: increment(1), lastActiveAt: serverTimestamp() }).catch(() => {});
  } catch (e) {
    showError(e.name === "AbortError" ? "The request timed out. Try a smaller excerpt." : (e.message || "Network error."));
  } finally { busy = false; refreshControls(); render(); }
}

async function send(text) {
  text = (text ?? input.value).trim();
  if (!text || busy) return;
  if (text.length > MAX_CHARS) return showError(`Message exceeds ${MAX_CHARS.toLocaleString()} characters. Trim it to the relevant section.`);
  hideError();
  messages.push({ role: "user", content: text });
  persist();
  input.value = ""; autosize();
  await ask();
}

sendBtn.addEventListener("click", () => send());
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); send(); }
});
$("retryBtn").addEventListener("click", () => { hideError(); if (messages.length && messages[messages.length - 1].role === "user") ask(); });
$("newBtn").addEventListener("click", () => {
  if (busy) return;
  if (messages.length && !confirm("Start a new chat? The current conversation will be cleared.")) return;
  messages = []; persist(); hideError(); render(); input.focus();
});

/* ============ Install (PWA) ============ */
let deferredPrompt = null;
const installBtn = $("installBtn");
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null; installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => { installBtn.hidden = true; });
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (isIOS && !standalone && !store.get("ggdx.iosHint")) $("iosHint").hidden = false;
$("iosClose").addEventListener("click", () => { $("iosHint").hidden = true; store.set("ggdx.iosHint", "1"); });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

setMode("signin");
