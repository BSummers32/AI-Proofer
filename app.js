import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, collection, addDoc, doc, getDoc, getDocs, updateDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp, deleteDoc, arrayUnion } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyAc4Vm815th4dUNmIbyMz631SirvAedkFg",
    authDomain: "ai-proofer-e4b94.firebaseapp.com",
    projectId: "ai-proofer-e4b94",
    storageBucket: "ai-proofer-e4b94.firebasestorage.app",
    messagingSenderId: "910098525294",
    appId: "1:910098525294:web:fbb25ef2f22ae497958a7f"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let currentUserData = null; // Stores firestore user data
let currentProject = null;
let isRevisionMode = false;
let originalImageSrc = null; // For diff
let chatUnsubscribe = null; // Listener cleanup

// --- EMAIL NOTIFICATION HELPER ---
async function sendNotification(toEmail, subject, htmlContent) {
    if (!toEmail) return; 
    try {
        const response = await fetch('/.netlify/functions/send-email', {
            method: 'POST',
            body: JSON.stringify({
                to: toEmail,
                subject: subject,
                html: htmlContent
            })
        });
        if (!response.ok) throw new Error("Email failed");
        console.log("Notification sent to " + toEmail);
    } catch (e) { console.error("Error sending notification:", e); }
}

// SIDEBAR TOGGLE
window.toggleSidebar = () => {
    const sb = document.getElementById('sidebar');
    const icon = document.getElementById('toggle-icon');
    sb.classList.toggle('collapsed');
    icon.innerHTML = sb.classList.contains('collapsed') ? '<polyline points="9 18 15 12 9 6"/>' : '<polyline points="15 18 9 12 15 6"/>';
};

window.signIn = () => signInWithPopup(auth, provider).catch(e => { document.getElementById('login-error').innerText = e.message; document.getElementById('login-error').classList.remove('hidden'); });
window.logout = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        // Start listening to user profile changes
        onSnapshot(doc(db, "users", user.uid), (docSnap) => {
            if (docSnap.exists()) {
                currentUserData = docSnap.data();
                loadDashboard(); // Refresh dashboard to update badges
            }
        });

        await setDoc(doc(db, "users", user.uid), {
            uid: user.uid,
            displayName: user.displayName,
            email: user.email,
            photoURL: user.photoURL,
            lastSeen: serverTimestamp()
        }, { merge: true });

        document.getElementById('view-login').classList.add('hidden');
        document.getElementById('view-app').classList.remove('hidden');
        document.getElementById('user-name').innerText = user.displayName;
        document.getElementById('user-avatar').src = user.photoURL;
        loadDashboard();
    } else {
        currentUser = null;
        currentUserData = null;
        document.getElementById('view-login').classList.remove('hidden');
        document.getElementById('view-app').classList.add('hidden');
    }
});

// DASHBOARD
window.showDashboard = () => { hideAllViews(); document.getElementById('view-dashboard').classList.remove('hidden'); loadDashboard(); };
window.showArchived = () => { hideAllViews(); document.getElementById('view-archived').classList.remove('hidden'); loadArchived(); };

async function loadDashboard() {
    if(!currentUser) return;
    const today = new Date();
    const firstDay = new Date(today.setDate(today.getDate() - today.getDay() + 1));
    const lastDay = new Date(today.setDate(today.getDate() - today.getDay() + 7));
    
    onSnapshot(query(collection(db, "projects")), (snapshot) => {
        const container = document.getElementById('list-team-projects');
        container.innerHTML = '';
        const docs = [];
        let activeCount = 0;
        let dueThisWeek = 0;

        snapshot.forEach(doc => {
            const d = doc.data();
            if(d.status !== 'Archived') {
                docs.push({ id: doc.id, ...d });
                activeCount++;
                if(d.deadlineFinal) {
                    const due = new Date(d.deadlineFinal);
                    if(due >= firstDay && due <= lastDay) dueThisWeek++;
                }
            }
        });
        
        document.getElementById('stat-total').innerText = activeCount;
        document.getElementById('stat-due').innerText = dueThisWeek;
        docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        if(docs.length === 0) container.innerHTML = '<div class="p-8 text-center text-slate-400">No active projects.</div>';
        docs.forEach(data => renderTeamRow(data, data.id, container));
    });

    onSnapshot(query(collection(db, "projects"), where("reviewerId", "==", currentUser.uid)), (snapshot) => {
        const container = document.getElementById('list-assigned-docs');
        const badge = document.getElementById('badge-assigned');
        container.innerHTML = '';
        const docs = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            if(d.status !== 'Archived' && d.status !== 'Approved') docs.push({ id: doc.id, ...d });
        });
        if(docs.length === 0) {
            container.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">All caught up!</div>';
            badge.innerText = "0";
        } else {
            badge.innerText = docs.length;
            docs.forEach(data => renderCard(data, data.id, container));
        }
    });
}

async function loadArchived() {
    onSnapshot(query(collection(db, "projects"), where("status", "==", "Archived")), (snapshot) => {
        const container = document.getElementById('list-archived-docs');
        container.innerHTML = '';
        if(snapshot.empty) { container.innerHTML = '<div class="p-8 text-center text-slate-400">No archived projects.</div>'; return; }
        snapshot.forEach(doc => renderTeamRow(doc.data(), doc.id, container, true));
    });
}

function renderTeamRow(data, id, container, isArchived = false) {
    const div = document.createElement('div');
    div.className = "grid grid-cols-12 px-5 py-4 border-b border-slate-100 hover:bg-slate-50 items-center transition group cursor-pointer";
    let priorityBadge = data.priority === "Urgent" ? `<span class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[10px] font-bold border border-red-200 uppercase tracking-wide">Urgent 🔥</span>` : data.priority === "High" ? `<span class="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[10px] font-bold border border-orange-200 uppercase tracking-wide">High</span>` : `<span class="bg-slate-100 text-slate-500 px-2 py-0.5 rounded text-[10px] font-bold border border-slate-200 uppercase tracking-wide">Normal</span>`;
    const nextDate = data.deadlineNext ? new Date(data.deadlineNext).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    const finalDate = data.deadlineFinal ? new Date(data.deadlineFinal).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    const canDelete = data.creatorId === currentUser.uid || data.reviewerId === currentUser.uid;
    const deleteBtn = canDelete ? `<button onclick="deleteProject('${id}', '${data.storagePath || ''}')" class="text-slate-300 hover:text-red-500 p-1.5 rounded hover:bg-red-50 transition"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>` : `<div class="w-8"></div>`;

    div.innerHTML = `
        <div class="col-span-1 text-center" onclick="event.stopPropagation()">${deleteBtn}</div>
        <div class="col-span-4" onclick="loadProject('${id}')"><div class="font-bold text-slate-700 text-sm">${data.title}</div><div class="text-[10px] text-slate-400 mt-0.5 font-bold uppercase tracking-wide">${data.mediaType}</div></div>
        <div class="col-span-2" onclick="loadProject('${id}')">${priorityBadge}</div>
        <div class="col-span-2 flex items-center gap-2" onclick="loadProject('${id}')"><img src="${data.creatorPhoto}" class="w-6 h-6 rounded-full border border-white shadow-sm"><span class="text-xs font-bold text-slate-600">${data.creatorName.split(' ')[0]}</span></div>
        <div class="col-span-3 text-right text-xs" onclick="loadProject('${id}')">${data.deadlineNext ? `<div class="text-slate-600 font-medium">⏱️ Next: <span class="text-emerald-600">${nextDate}</span></div>` : ''}${data.deadlineFinal ? `<div class="text-slate-400 mt-0.5">🏁 Final: ${finalDate}</div>` : ''}</div>
    `;
    container.appendChild(div);
}

function renderCard(data, id, container) {
    const div = document.createElement('div');
    div.className = "bg-white/10 p-4 rounded-xl border border-white/5 hover:bg-white/15 transition cursor-pointer group relative";
    div.onclick = () => loadProject(id);
    let badge = data.priority === "Urgent" ? `<span class="bg-red-500/20 text-red-300 text-[10px] font-bold px-2 py-0.5 rounded uppercase border border-red-500/30">Urgent 🔥</span>` : "";
    
    // CHAT NOTIFICATION LOGIC
    let showChatBadge = false;
    if (currentUserData && data.lastChatAt) {
        // If we have viewed this project before, check timestamps
        const lastView = currentUserData.projectViews && currentUserData.projectViews[id] ? currentUserData.projectViews[id].seconds : 0;
        const lastChat = data.lastChatAt.seconds;
        if (lastChat > lastView) showChatBadge = true;
    }

    const chatIndicator = showChatBadge ? 
        `<div class="flex items-center gap-1 bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full chat-badge ml-2 shadow-lg z-10">
            <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            New Message
            </div>` : '';

    div.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <div class="flex items-center">
                ${badge}
                ${chatIndicator}
            </div>
            <span class="text-emerald-400 font-bold text-[10px] uppercase ml-auto">${data.status}</span>
        </div>
        <h4 class="font-bold text-sm mb-3 text-white">${data.title}</h4>
        <div class="flex justify-between items-end">
            <div class="text-xs text-slate-400">From: <span class="text-white font-bold">${data.creatorName.split(' ')[0]}</span></div>
            <div class="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white shadow-lg shadow-emerald-500/50">${data.creatorName[0]}</div>
        </div>
    `;
    container.appendChild(div);
}

window.deleteProject = async (id, path) => {
    if(!confirm("⚠️ PERMANENT DELETE\nAre you sure you want to remove this project?")) return;
    try {
        await deleteDoc(doc(db, "projects", id));
        if(path) { try { await deleteObject(ref(storage, path)); } catch(e){} }
        alert("Project deleted.");
    } catch(e) { alert("Error: " + e.message); }
};

// --- UPLOAD ---
window.startUpload = (revisionMode = false) => {
    isRevisionMode = revisionMode;
    hideAllViews();
    document.getElementById('view-wizard').classList.remove('hidden');
    const t = document.getElementById('input-title');
    if(isRevisionMode && currentProject) {
        document.getElementById('wizard-title').innerText = "Upload Revision";
        t.value = currentProject.title + " (v2)";
        t.disabled = true;
        document.getElementById('type-group').classList.add('hidden');
        document.getElementById('context-group').classList.add('hidden');
        document.getElementById('btn-submit-project').innerText = "Verify Revision";
    } else {
        document.getElementById('wizard-title').innerText = "Upload New Content";
        t.value = "";
        t.disabled = false;
        document.getElementById('type-group').classList.remove('hidden');
        document.getElementById('context-group').classList.remove('hidden');
        document.getElementById('btn-submit-project').innerText = "Analyze & Save Project";
    }
    document.getElementById('file-upload').value = '';
    document.getElementById('file-preview-name').innerText = "Click to upload document";
};

let fileToUpload = null;
let fileBase64 = null;

window.handleFilePreview = (input) => {
    if(input.files[0]) {
        fileToUpload = input.files[0];
        document.getElementById('file-preview-name').innerText = fileToUpload.name;
        const reader = new FileReader();
        reader.onload = (e) => fileBase64 = e.target.result;
        reader.readAsDataURL(fileToUpload);
    }
};

window.submitProject = async () => {
    const title = document.getElementById('input-title').value;
    const btn = document.getElementById('btn-submit-project');
    const statusMsg = document.getElementById('upload-status');
    if(!fileToUpload) return alert("Please upload a file");

    btn.disabled = true;
    statusMsg.classList.remove('hidden');
    try {
        const contentRaw = fileBase64.split(',')[1];
        const isBinary = fileToUpload.type.startsWith('image/') || fileToUpload.type === 'application/pdf';
        const type = document.getElementById('input-type').value;
        
        const payload = {
            mode: 'analyze',
            content: contentRaw,
            mediaType: isRevisionMode ? currentProject.mediaType : type,
            mimeType: fileToUpload.type,
            isBinary: isBinary,
            targetAudience: document.getElementById('input-audience').value,
            priority: document.getElementById('input-priority').value
        };

        if(isRevisionMode && currentProject.aiSuggestions) {
            const accepted = currentProject.aiSuggestions.filter(s => s.status === 'accepted');
            if(accepted.length > 0) {
                payload.mode = 'verify';
                payload.expectedEdits = accepted;
            }
        }

        const res = await fetch('/.netlify/functions/proof-read', { method: 'POST', body: JSON.stringify(payload) });
        if(!res.ok) throw new Error("AI Analysis Failed");
        let suggestions = await res.json();
        if(payload.mode === 'verify') {
            suggestions = suggestions.map((r, i) => ({
                id: i, original: "Pending Fix", fix: r.fix, 
                reason: r.status === 'verified' ? "✅ Verified Fix" : "❌ Fix Failed",
                status: r.status === 'verified' ? 'accepted' : 'rejected'
            }));
        } else {
            suggestions = suggestions.map(s => ({...s, status: 'pending'}));
        }

        const storageRef = ref(storage, `projects/${currentUser.uid}/${Date.now()}_${fileToUpload.name}`);
        await uploadString(storageRef, fileBase64, 'data_url');
        const url = await getDownloadURL(storageRef);

        const commonData = {
            fileURL: url,
            storagePath: storageRef.fullPath,
            fileMime: fileToUpload.type,
            aiSuggestions: suggestions,
            priority: document.getElementById('input-priority').value,
            deadlineFinal: document.getElementById('input-deadline-final').value,
            deadlineNext: document.getElementById('input-deadline-next').value
        };

        if(isRevisionMode) {
            await updateDoc(doc(db, "projects", currentProject.id), { ...commonData, status: 'Needs Review', managerComments: '', isRevision: true });
            loadProject(currentProject.id);
        } else {
            const docRef = await addDoc(collection(db, "projects"), {
                title: title,
                mediaType: type,
                status: 'Draft',
                creatorId: currentUser.uid,
                creatorName: currentUser.displayName,
                creatorEmail: currentUser.email,
                creatorPhoto: currentUser.photoURL,
                createdAt: serverTimestamp(),
                reviewerId: null,
                ...commonData
            });
            loadProject(docRef.id);
        }
    } catch(e) {
        console.error(e);
        alert(e.message);
        btn.disabled = false;
        statusMsg.classList.add('hidden');
    }
};

// --- PROJECT VIEW ---
window.loadProject = async (id) => {
    hideAllViews();
    if(chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; }
    document.getElementById('view-project').classList.remove('hidden');
    
    // Mark chat as Read for this user
    if (currentUser) {
        setDoc(doc(db, "users", currentUser.uid), {
            projectViews: { [id]: serverTimestamp() }
        }, { merge: true });
    }

    onSnapshot(doc(db, "projects", id), (snap) => {
        if(snap.exists()) {
            currentProject = { id: snap.id, ...snap.data() };
            renderProjectView();
        } else { showDashboard(); }
    });

    const chatRef = query(collection(db, "projects", id, "messages"), orderBy("createdAt", "asc"));
    chatUnsubscribe = onSnapshot(chatRef, (snapshot) => {
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';
        if(snapshot.empty) container.innerHTML = '<div class="text-center text-xs text-slate-400 mt-4">Start the conversation...</div>';
        snapshot.forEach(doc => {
            const msg = doc.data();
            const isMe = msg.senderId === currentUser.uid;
            const time = msg.createdAt ? new Date(msg.createdAt.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '...';
            container.innerHTML += `<div class="flex flex-col ${isMe ? 'items-end' : 'items-start'}"><div class="flex items-end gap-2 max-w-[85%]">${!isMe ? `<div class="w-6 h-6 rounded-full bg-slate-200 text-[10px] flex items-center justify-center font-bold text-slate-600 shrink-0" title="${msg.senderName}">${msg.senderName[0]}</div>` : ''}<div class="${isMe ? 'bg-blue-500 text-white' : 'bg-white border border-slate-200 text-slate-700'} rounded-2xl px-3 py-2 text-sm shadow-sm">${msg.text}</div></div><span class="text-[10px] text-slate-400 mt-1 mx-2">${time}</span></div>`;
        });
        container.scrollTop = container.scrollHeight;
    });
    
    // Default to AI tab
    window.switchTab('tab-ai');
};

// TAB SWITCHING
window.switchTab = (tabId) => {
    ['tab-ai', 'tab-review', 'tab-chat'].forEach(t => document.getElementById(t).classList.add('hidden'));
    ['btn-tab-ai', 'btn-tab-review', 'btn-tab-chat'].forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById('btn-' + tabId).classList.add('active');
};

function renderProjectView() {
    const p = currentProject;
    document.getElementById('project-title-display').innerText = p.title;
    document.getElementById('project-status-badge').innerText = p.status;
    document.getElementById('project-priority-badge').innerText = p.priority || 'Normal';
    if(p.isRevision) document.getElementById('verification-badge').classList.remove('hidden');
    
    // Doc View
    const docContainer = document.getElementById('doc-view-container');
    const diffContainer = document.getElementById('diff-view-container');
    const diffMsg = document.getElementById('diff-toggle-msg');
    docContainer.innerHTML = '';
    
    if(p.status === 'Archived') {
        docContainer.innerHTML = '<div class="p-12 text-center text-slate-400 italic">Project Archived.</div>';
        diffContainer.classList.add('hidden');
    } else if(p.isRevision && p.fileMime.startsWith('image/') && originalImageSrc) {
        docContainer.classList.add('hidden');
        diffContainer.classList.remove('hidden');
        diffMsg.classList.remove('hidden');
        document.getElementById('diff-img-new').src = p.fileURL;
        if(originalImageSrc) document.getElementById('diff-img-old').src = originalImageSrc;
        else {
            docContainer.classList.remove('hidden');
            diffContainer.classList.add('hidden');
            docContainer.innerHTML = `<img src="${p.fileURL}" class="max-w-full h-auto mx-auto shadow-lg rounded">`;
        }
    } else {
        docContainer.classList.remove('hidden');
        diffContainer.classList.add('hidden');
        diffMsg.classList.add('hidden');
        if(p.fileMime.startsWith('image/')) {
            docContainer.innerHTML = `<img src="${p.fileURL}" class="max-w-full h-auto mx-auto shadow-lg rounded">`;
            originalImageSrc = p.fileURL; 
        } else if(p.fileMime === 'application/pdf') {
            docContainer.innerHTML = `<iframe src="${p.fileURL}" class="w-full h-full border-0 rounded"></iframe>`;
        } else {
            docContainer.innerHTML = `<div class="p-8">File available for download.</div>`;
        }
    }

    const isReviewer = p.reviewerId === currentUser.uid;
    const canEdit = (p.creatorId === currentUser.uid || isReviewer) && p.status !== 'Approved' && p.status !== 'Archived';

    // 1. RENDER AI LIST
    const aiList = document.getElementById('ai-feedback-list');
    aiList.innerHTML = '';
    if(!p.aiSuggestions || p.aiSuggestions.length === 0) aiList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No AI suggestions found.</div>';
    (p.aiSuggestions || []).forEach((s, idx) => {
        let statusClass = 'status-pending';
        if(s.status === 'accepted') statusClass = 'status-accepted';
        if(s.status === 'rejected') statusClass = 'status-rejected';

        let btns = '';
        if(canEdit) {
            btns = `<div class="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                <button onclick="updateSuggestion(${idx}, 'accepted')" class="flex-1 text-emerald-600 hover:bg-emerald-50 py-1.5 rounded text-xs font-bold transition">Accept ✔️</button>
                <button onclick="updateSuggestion(${idx}, 'rejected')" class="flex-1 text-red-500 hover:bg-red-50 py-1.5 rounded text-xs font-bold transition">Reject ❌</button>
            </div>`;
        }

        aiList.innerHTML += `
            <div class="suggestion-card p-5 mb-4 ${statusClass}">
                <div class="flex justify-between items-start mb-2">
                    <span class="text-sm font-bold text-slate-800 leading-tight">${s.reason}</span>
                    ${s.status !== 'pending' ? `<span class="text-[10px] font-bold uppercase ml-2 ${s.status === 'accepted' ? 'text-emerald-600' : 'text-red-500'}">${s.status}</span>` : ''}
                </div>
                <div class="diff-block">
                    <div class="diff-old">${s.original}</div>
                    <div class="text-center text-slate-300 text-xs">↓</div>
                    <div class="diff-new">${s.fix}</div>
                </div>
                ${btns}
            </div>
        `;
    });

    // 2. RENDER MANUAL LIST
    const manualList = document.getElementById('manual-feedback-list');
    manualList.innerHTML = '';
    if(!p.reviewerSuggestions || p.reviewerSuggestions.length === 0) manualList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No reviewer notes yet.</div>';
    
    (p.reviewerSuggestions || []).forEach((s) => {
        manualList.innerHTML += `
            <div class="suggestion-card p-5 mb-4 status-manual">
                <div class="flex justify-between items-start mb-2">
                    <span class="text-sm font-bold text-slate-800 leading-tight">${s.reason}</span>
                    <span class="text-[10px] font-bold text-blue-500 uppercase ml-2">Note</span>
                </div>
                <div class="diff-block">
                    ${s.original ? `<div class="diff-old">${s.original}</div>` : ''}
                    ${s.fix ? `<div class="diff-new">${s.fix}</div>` : ''}
                </div>
            </div>
        `;
    });

    // Toggle Input Forms
    document.getElementById('manual-note-form').classList.add('hidden');
    
    // Actions
    const actions = document.getElementById('action-buttons');
    actions.innerHTML = '';
    
    if(p.creatorId === currentUser.uid) {
        if(p.status === 'Draft') actions.innerHTML = `<button onclick="openAssignModal()" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Assign Reviewer</button>`;
        if(p.status === 'Changes Requested') actions.innerHTML = `<button onclick="startUpload(true)" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Upload Revision</button>`;
    } 
    if(isReviewer && p.status === 'Needs Review') {
        // Reviewer Mode
        document.getElementById('manual-note-form').classList.remove('hidden');
        
        actions.innerHTML = `
            <button onclick="submitReview('Changes Requested')" class="bg-white border border-red-200 text-red-600 px-4 py-2 rounded-lg text-sm font-bold hover:bg-red-50 transition">Request Changes</button>
            <button onclick="openChecklist()" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Approve Concept</button>
        `;
    }
    if(p.status === 'Approved' && (p.creatorId === currentUser.uid || isReviewer)) {
        actions.innerHTML = `<button onclick="finalizeProject()" class="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 transition shadow-lg">Final Commit (Archive)</button>`;
    }
}

// --- INTERACTIONS ---
window.updateSuggestion = async (i, s) => {
    const newS = [...currentProject.aiSuggestions];
    newS[i].status = s;
    await updateDoc(doc(db, "projects", currentProject.id), { aiSuggestions: newS });
};

window.addManualSuggestion = async () => {
    const reason = document.getElementById('manual-reason').value;
    const original = document.getElementById('manual-original').value;
    const fix = document.getElementById('manual-fix').value;
    
    if(!reason) return alert("Please enter a summary or reason.");

    try {
        const newNote = {
            reason, original, fix,
            createdAt: Date.now(),
            creatorId: currentUser.uid
        };
        await updateDoc(doc(db, "projects", currentProject.id), {
            reviewerSuggestions: arrayUnion(newNote)
        });
        // Clear form
        document.getElementById('manual-reason').value = '';
        document.getElementById('manual-original').value = '';
        document.getElementById('manual-fix').value = '';
    } catch(e) { console.error(e); }
};

window.moveDiff = (e) => {
    const rect = document.querySelector('.diff-container').getBoundingClientRect();
    const x = (e.clientX || e.touches[0].clientX) - rect.left;
    const p = Math.max(0, Math.min(100, (x / rect.width) * 100));
    document.getElementById('diff-resize').style.width = p + '%';
    document.getElementById('diff-handle').style.left = p + '%';
};

// --- CHAT FEATURE ---
window.sendChatMessage = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if(!text || !currentProject) return;
    try {
        // 1. Add Message
        await addDoc(collection(db, "projects", currentProject.id, "messages"), {
            text: text,
            senderId: currentUser.uid,
            senderName: currentUser.displayName,
            createdAt: serverTimestamp()
        });
        
        // 2. Update Project Timestamp (Triggers notification for others)
        await updateDoc(doc(db, "projects", currentProject.id), { 
            lastChatAt: serverTimestamp() 
        });

        // 3. Mark as Read for Me (So I don't see notification)
        await setDoc(doc(db, "users", currentUser.uid), {
            projectViews: { [currentProject.id]: serverTimestamp() }
        }, { merge: true });

        input.value = '';
    } catch(err) { console.error("Chat error:", err); }
};

// --- ASSIGN ---
window.openAssignModal = async () => {
    document.getElementById('modal-assign').classList.remove('hidden');
    const list = document.getElementById('user-list-container');
    list.innerHTML = 'Loading...';
    const snaps = await getDocs(collection(db, "users"));
    list.innerHTML = '';
    snaps.forEach(s => {
        const u = s.data();
        if(u.uid === currentUser.uid) return;
        const div = document.createElement('div');
        div.className = "user-bubble cursor-pointer flex flex-col items-center p-3 rounded-xl border border-transparent transition bg-slate-50 hover:bg-white hover:shadow-md border hover:border-emerald-100";
        div.onclick = async () => {
            if(confirm(`Assign ${u.displayName}?`)) {
                await updateDoc(doc(db, "projects", currentProject.id), { reviewerId: u.uid, reviewerName: u.displayName, status: 'Needs Review' });
                if (u.email) {
                    sendNotification(u.email, `New Assignment: ${currentProject.title}`, `<p>You have been assigned to review <b>${currentProject.title}</b>.</p><p>Please log in to Proof Buddy to view it.</p>`);
                }
                closeModal('modal-assign');
            }
        };
        div.innerHTML = `<img src="${u.photoURL}" class="w-12 h-12 rounded-full mb-2 shadow-sm"><span class="text-xs font-bold text-slate-700">${u.displayName.split(' ')[0]}</span>`;
        list.appendChild(div);
    });
};

// --- APPROVALS ---
window.openChecklist = () => { document.getElementById('modal-checklist').classList.remove('hidden'); document.getElementById('btn-confirm-approve').disabled = true; document.querySelectorAll('.approval-check').forEach(c => c.checked = false); };
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.validateChecklist = () => { document.getElementById('btn-confirm-approve').disabled = !Array.from(document.querySelectorAll('.approval-check')).every(c => c.checked); };

window.executeApproval = () => {
    submitReview('Approved');
    closeModal('modal-checklist');
};

window.submitReview = async (status) => {
    // Manager comments now handled via notes, but we can pass a final generic message if needed.
    await updateDoc(doc(db, "projects", currentProject.id), { status: status });
    if (currentProject.creatorEmail) {
        sendNotification(currentProject.creatorEmail, `Project Update: ${status}`, `<p>Your project <b>${currentProject.title}</b> has been marked as: <b>${status}</b>.</p>`);
    }
};

window.finalizeProject = async () => {
    if(!confirm("Archive and delete source file?")) return;
    try {
        if(currentProject.storagePath) await deleteObject(ref(storage, currentProject.storagePath));
        await updateDoc(doc(db, "projects", currentProject.id), { status: 'Archived', fileURL: null, archivedAt: serverTimestamp() });
        alert("Project Archived.");
        showDashboard();
    } catch(e) { alert(e.message); }
};

function hideAllViews() {
    ['view-login', 'view-dashboard', 'view-wizard', 'view-project', 'view-archived'].forEach(v => document.getElementById(v).classList.add('hidden'));
}