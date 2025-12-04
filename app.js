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

// State
let currentUser = null;
let currentUserData = null; 
let currentProject = null;
let isRevisionMode = false;
let originalImageSrc = null; 
let chatUnsubscribe = null; 
let fileToUpload = null;
let fileBase64 = null;

// --- GLOBAL BINDINGS (Fixes Button Clicks) ---
window.toggleSidebar = () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
};

window.signIn = () => signInWithPopup(auth, provider).catch(e => { 
    document.getElementById('login-error').innerText = e.message; 
    document.getElementById('login-error').classList.remove('hidden'); 
});

window.logout = () => signOut(auth);

// --- NAVIGATION & TABS (Fixes Glitch #1) ---
window.showDashboard = () => { hideAllViews(); document.getElementById('view-dashboard').classList.remove('hidden'); loadDashboard(); };
window.showArchived = () => { hideAllViews(); document.getElementById('view-archived').classList.remove('hidden'); loadArchived(); };

window.switchTab = (tabId) => {
    // Hide all tabs
    ['tab-ai', 'tab-review', 'tab-chat'].forEach(t => document.getElementById(t).classList.add('hidden'));
    // Deactivate all buttons
    ['btn-tab-ai', 'btn-tab-review', 'btn-tab-chat'].forEach(b => document.getElementById(b).classList.remove('active'));
    
    // Show selected
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById('btn-' + tabId).classList.add('active');
};

// --- FILE HANDLING (Fixes Glitch #2 & Adds MP4) ---
window.handleFilePreview = (input) => {
    if(input.files && input.files[0]) {
        fileToUpload = input.files[0];
        document.getElementById('file-preview-name').innerText = fileToUpload.name;
        
        // Show loading state if large file
        if(fileToUpload.size > 5 * 1024 * 1024) {
            document.getElementById('file-preview-name').innerText += " (Processing...)";
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            fileBase64 = e.target.result;
            // Restore name after processing
            document.getElementById('file-preview-name').innerText = fileToUpload.name; 
        };
        reader.readAsDataURL(fileToUpload);
    }
};

window.startUpload = (revisionMode = false) => {
    isRevisionMode = revisionMode;
    hideAllViews();
    document.getElementById('view-wizard').classList.remove('hidden');
    
    // Reset fields
    fileToUpload = null;
    fileBase64 = null;
    document.getElementById('file-upload').value = '';
    document.getElementById('file-preview-name').innerText = "Click to upload document or video";
    
    const t = document.getElementById('input-title');
    if(isRevisionMode && currentProject) {
        document.getElementById('wizard-title').innerText = "Upload Revision";
        t.value = currentProject.title; 
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
};

window.submitProject = async () => {
    const title = document.getElementById('input-title').value;
    const btn = document.getElementById('btn-submit-project');
    const statusMsg = document.getElementById('upload-status');

    if(!fileToUpload) return alert("Please upload a file first.");
    if(!fileBase64) return alert("File is still processing. Please wait a moment.");

    btn.disabled = true;
    statusMsg.classList.remove('hidden');

    try {
        // Strip data:image/png;base64, prefix for the API
        const contentRaw = fileBase64.split(',')[1];
        const mimeType = fileToUpload.type;
        const isImage = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf';
        const isVideo = mimeType.startsWith('video/');
        const isBinary = isImage || isPdf || isVideo;

        const payload = {
            mode: 'analyze',
            content: contentRaw,
            mediaType: isRevisionMode ? currentProject.mediaType : document.getElementById('input-type').value,
            mimeType: mimeType,
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

        // Call Netlify Function
        const res = await fetch('/.netlify/functions/proof-read', { 
            method: 'POST', 
            body: JSON.stringify(payload) 
        });
        
        if(!res.ok) throw new Error("AI Analysis Failed. File might be too large for free tier.");
        let suggestions = await res.json();
        
        // Format suggestions
        if(payload.mode === 'verify') {
            suggestions = suggestions.map((r, i) => ({
                id: i, original: "Pending Fix", fix: r.fix, 
                reason: r.status === 'verified' ? "✅ Verified Fix" : "❌ Fix Failed",
                status: r.status === 'verified' ? 'accepted' : 'rejected'
            }));
        } else {
            suggestions = suggestions.map(s => ({...s, status: 'pending'}));
        }

        // Upload to Firebase Storage
        const storageRef = ref(storage, `projects/${currentUser.uid}/${Date.now()}_${fileToUpload.name}`);
        await uploadString(storageRef, fileBase64, 'data_url');
        const url = await getDownloadURL(storageRef);

        const commonData = {
            fileURL: url,
            storagePath: storageRef.fullPath,
            fileMime: mimeType,
            aiSuggestions: suggestions,
            priority: document.getElementById('input-priority').value,
            deadlineFinal: document.getElementById('input-deadline-final').value,
            deadlineNext: document.getElementById('input-deadline-next').value
        };

        if(isRevisionMode) {
            const newCount = (currentProject.revisionCount || 0) + 1;
            await updateDoc(doc(db, "projects", currentProject.id), { 
                ...commonData, 
                status: 'Needs Review', 
                managerComments: '', 
                isRevision: true,
                revisionCount: newCount 
            });
            window.loadProject(currentProject.id);
        } else {
            const docRef = await addDoc(collection(db, "projects"), {
                title: title,
                mediaType: payload.mediaType,
                status: 'Draft',
                revisionCount: 0,
                creatorId: currentUser.uid,
                creatorName: currentUser.displayName,
                creatorEmail: currentUser.email,
                creatorPhoto: currentUser.photoURL,
                createdAt: serverTimestamp(),
                reviewerId: null,
                ...commonData
            });
            window.loadProject(docRef.id);
        }
    } catch(e) {
        console.error(e);
        alert("Upload Error: " + e.message);
        btn.disabled = false;
        statusMsg.classList.add('hidden');
    }
};

// --- AUTH LISTENER ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        onSnapshot(doc(db, "users", user.uid), (docSnap) => {
            if (docSnap.exists()) {
                currentUserData = docSnap.data();
                loadDashboard(); 
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
        document.getElementById('view-login').classList.remove('hidden');
        document.getElementById('view-app').classList.add('hidden');
    }
});

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

function renderTeamRow(data, id, container, isArchived = false) {
    const div = document.createElement('div');
    div.className = "grid grid-cols-12 px-5 py-4 border-b border-slate-100 hover:bg-slate-50 items-center transition group cursor-pointer relative";
    
    let statusColor = "bg-slate-100 text-slate-600";
    if (data.status === 'Needs Review') statusColor = "bg-blue-100 text-blue-700";
    if (data.status === 'Changes Requested') statusColor = "bg-red-100 text-red-700";
    if (data.status === 'Approved') statusColor = "bg-emerald-100 text-emerald-700";
    
    let revisionText = data.revisionCount > 0 ? `${data.revisionCount} Revision` : "Original";
    if(data.revisionCount === 1) revisionText = "1st Revision";
    else if(data.revisionCount === 2) revisionText = "2nd Revision";

    let priorityBadge = data.priority === "Urgent" ? `<span class="text-red-600 font-bold text-xs uppercase">🔥 Urgent</span>` : 
                        data.priority === "High" ? `<span class="text-orange-500 font-bold text-xs">High</span>` : 
                        `<span class="text-slate-400 text-xs">Normal</span>`;

    const nextDate = data.deadlineNext ? new Date(data.deadlineNext).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    
    const canDelete = data.creatorId === currentUser.uid || data.reviewerId === currentUser.uid;
    const deleteBtn = canDelete ? 
        `<button onclick="deleteProject('${id}', '${data.storagePath || ''}')" class="text-slate-300 hover:text-red-500 p-1.5 rounded hover:bg-red-50 transition z-10 relative"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>` : `<div class="w-8"></div>`;

    // Chat Notification
    let showChatBadge = false;
    if (currentUserData && data.lastChatAt) {
        const lastView = currentUserData.projectViews && currentUserData.projectViews[id] ? currentUserData.projectViews[id].seconds : 0;
        const lastChat = data.lastChatAt.seconds;
        if (lastChat > lastView) showChatBadge = true;
    }

    div.onclick = () => window.loadProject(id);

    div.innerHTML = `
        <div class="col-span-1 text-center" onclick="event.stopPropagation()">${deleteBtn}</div>
        <div class="col-span-4 relative">
            <div class="flex items-center gap-2">
                <div class="font-bold text-slate-700 text-sm truncate pr-2">${data.title}</div>
                ${showChatBadge ? `<div class="bg-blue-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold animate-pulse">New Msg</div>` : ''}
            </div>
            <div class="text-[10px] text-slate-400 mt-0.5 font-bold uppercase tracking-wide">${data.mediaType} • ${revisionText}</div>
        </div>
        <div class="col-span-2">
            <span class="${statusColor} text-[10px] font-bold px-2 py-1 rounded uppercase border border-current opacity-80">${data.status}</span>
        </div>
        <div class="col-span-2">${priorityBadge}</div>
        <div class="col-span-1 flex items-center gap-2">
            <img src="${data.creatorPhoto}" class="w-6 h-6 rounded-full border border-white shadow-sm" title="${data.creatorName}">
        </div>
        <div class="col-span-2 text-right text-xs text-slate-500 font-medium">
            ${data.deadlineNext ? `Due: ${nextDate}` : ''}
        </div>
    `;
    container.appendChild(div);
}

function renderCard(data, id, container) {
    const div = document.createElement('div');
    div.className = "bg-white/10 p-4 rounded-xl border border-white/5 hover:bg-white/15 transition cursor-pointer group relative";
    div.onclick = () => window.loadProject(id);
    
    let badge = data.priority === "Urgent" ? `<span class="bg-red-500/20 text-red-300 text-[10px] font-bold px-2 py-0.5 rounded uppercase border border-red-500/30">Urgent 🔥</span>` : "";
    
    let showChatBadge = false;
    if (currentUserData && data.lastChatAt) {
        const lastView = currentUserData.projectViews && currentUserData.projectViews[id] ? currentUserData.projectViews[id].seconds : 0;
        const lastChat = data.lastChatAt.seconds;
        if (lastChat > lastView) showChatBadge = true;
    }

    const chatIndicator = showChatBadge ? 
        `<div class="flex items-center gap-1 bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full chat-badge ml-2 shadow-lg z-10">New Message</div>` : '';

    div.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <div class="flex items-center gap-2">
                ${badge}
                ${chatIndicator}
            </div>
            <span class="text-emerald-400 font-bold text-[10px] uppercase ml-auto">${data.status}</span>
        </div>
        <h4 class="font-bold text-sm mb-3 text-white truncate">${data.title}</h4>
        <div class="flex justify-between items-end">
            <div class="text-xs text-slate-400">From: <span class="text-white font-bold">${data.creatorName.split(' ')[0]}</span></div>
            <div class="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white shadow-lg shadow-emerald-500/50">${data.creatorName[0]}</div>
        </div>
    `;
    container.appendChild(div);
}

// --- PROJECT VIEW (Updated for MP4) ---
window.loadProject = async (id) => {
    hideAllViews();
    if(chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; }
    document.getElementById('view-project').classList.remove('hidden');
    
    if (currentUser) {
        setDoc(doc(db, "users", currentUser.uid), {
            projectViews: { [id]: serverTimestamp() }
        }, { merge: true });
    }

    onSnapshot(doc(db, "projects", id), (snap) => {
        if(snap.exists()) {
            currentProject = { id: snap.id, ...snap.data() };
            renderProjectView();
        } else { window.showDashboard(); }
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
    
    window.switchTab('tab-ai');
};

function renderProjectView() {
    const p = currentProject;
    document.getElementById('project-title-display').innerText = p.title;
    document.getElementById('project-status-badge').innerText = p.status;
    document.getElementById('project-priority-badge').innerText = p.priority || 'Normal';
    if(p.isRevision) document.getElementById('verification-badge').classList.remove('hidden');
    
    const docContainer = document.getElementById('doc-view-container');
    const diffContainer = document.getElementById('diff-view-container');
    const diffMsg = document.getElementById('diff-toggle-msg');
    docContainer.innerHTML = '';
    
    // MP4 & Image Logic
    if(p.status === 'Archived') {
        docContainer.innerHTML = '<div class="p-12 text-center text-slate-400 italic">Project Archived.</div>';
        diffContainer.classList.add('hidden');
    } else {
        // Reset Diff Mode
        docContainer.classList.remove('hidden');
        diffContainer.classList.add('hidden');
        diffMsg.classList.add('hidden');

        if(p.fileMime.startsWith('image/')) {
            docContainer.innerHTML = `<img src="${p.fileURL}" class="max-w-full h-auto mx-auto shadow-lg rounded">`;
            originalImageSrc = p.fileURL; 
        } else if(p.fileMime === 'application/pdf') {
            docContainer.innerHTML = `<iframe src="${p.fileURL}" class="w-full h-full border-0 rounded"></iframe>`;
        } else if(p.fileMime.startsWith('video/')) {
            // New Video Player
            docContainer.innerHTML = `
                <div class="bg-black rounded-xl overflow-hidden shadow-lg w-full flex justify-center">
                    <video controls src="${p.fileURL}" class="max-h-[600px] max-w-full"></video>
                </div>`;
        } else {
            docContainer.innerHTML = `<div class="p-8 text-center"><a href="${p.fileURL}" target="_blank" class="text-blue-500 underline">Download File</a></div>`;
        }
    }

    const isReviewer = p.reviewerId === currentUser.uid;
    const canEdit = (p.creatorId === currentUser.uid || isReviewer) && p.status !== 'Approved' && p.status !== 'Archived';

    // Render Lists (AI, Manual) - SAME AS BEFORE
    const aiList = document.getElementById('ai-feedback-list');
    aiList.innerHTML = '';
    if(!p.aiSuggestions || p.aiSuggestions.length === 0) aiList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No AI suggestions found.</div>';
    (p.aiSuggestions || []).forEach((s, idx) => {
        let statusClass = s.status === 'accepted' ? 'status-accepted' : s.status === 'rejected' ? 'status-rejected' : 'status-pending';
        let btns = '';
        if(canEdit) {
            btns = `<div class="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                <button onclick="updateSuggestion(${idx}, 'accepted')" class="flex-1 text-emerald-600 hover:bg-emerald-50 py-1.5 rounded text-xs font-bold transition">Accept ✔️</button>
                <button onclick="updateSuggestion(${idx}, 'rejected')" class="flex-1 text-red-500 hover:bg-red-50 py-1.5 rounded text-xs font-bold transition">Reject ❌</button>
            </div>`;
        }
        aiList.innerHTML += `
            <div class="suggestion-card p-5 mb-4 ${statusClass}">
                <div class="flex justify-between items-start mb-2"><span class="text-sm font-bold text-slate-800 leading-tight">${s.reason}</span>${s.status !== 'pending' ? `<span class="text-[10px] font-bold uppercase ml-2 ${s.status === 'accepted' ? 'text-emerald-600' : 'text-red-500'}">${s.status}</span>` : ''}</div>
                <div class="diff-block"><div class="diff-old">${s.original}</div><div class="text-center text-slate-300 text-xs">↓</div><div class="diff-new">${s.fix}</div></div>
                ${btns}
            </div>`;
    });

    const manualList = document.getElementById('manual-feedback-list');
    manualList.innerHTML = '';
    if(!p.reviewerSuggestions || p.reviewerSuggestions.length === 0) manualList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No reviewer notes yet.</div>';
    (p.reviewerSuggestions || []).forEach((s) => {
        manualList.innerHTML += `
            <div class="suggestion-card p-5 mb-4 status-manual">
                <div class="flex justify-between items-start mb-2"><span class="text-sm font-bold text-slate-800 leading-tight">${s.reason}</span><span class="text-[10px] font-bold text-blue-500 uppercase ml-2">Note</span></div>
                <div class="diff-block">${s.original ? `<div class="diff-old">${s.original}</div>` : ''}${s.fix ? `<div class="diff-new">${s.fix}</div>` : ''}</div>
            </div>`;
    });

    document.getElementById('manual-note-form').classList.add('hidden');
    const actions = document.getElementById('action-buttons');
    actions.innerHTML = '';
    
    if(p.creatorId === currentUser.uid) {
        if(p.status === 'Draft') actions.innerHTML = `<button onclick="openAssignModal()" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Assign Reviewer</button>`;
        if(p.status === 'Changes Requested') actions.innerHTML = `<button onclick="startUpload(true)" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Upload Revision</button>`;
    } 
    if(isReviewer && p.status === 'Needs Review') {
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

// --- INTERACTIONS (Global) ---
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
        const newNote = { reason, original, fix, createdAt: Date.now(), creatorId: currentUser.uid };
        await updateDoc(doc(db, "projects", currentProject.id), { reviewerSuggestions: arrayUnion(newNote) });
        document.getElementById('manual-reason').value = '';
        document.getElementById('manual-original').value = '';
        document.getElementById('manual-fix').value = '';
    } catch(e) { console.error(e); }
};

window.sendChatMessage = async (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if(!text || !currentProject) return;
    try {
        await addDoc(collection(db, "projects", currentProject.id, "messages"), {
            text: text,
            senderId: currentUser.uid,
            senderName: currentUser.displayName,
            createdAt: serverTimestamp()
        });
        await updateDoc(doc(db, "projects", currentProject.id), { lastChatAt: serverTimestamp() });
        // Mark as read for self
        await setDoc(doc(db, "users", currentUser.uid), {
            projectViews: { [currentProject.id]: serverTimestamp() }
        }, { merge: true });
        input.value = '';
    } catch(err) { console.error("Chat error:", err); }
};

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
                if (u.email) sendNotification(u.email, `New Assignment: ${currentProject.title}`, `<p>You have been assigned to review <b>${currentProject.title}</b>.</p><p>Please log in to Proof Buddy to view it.</p>`);
                window.closeModal('modal-assign');
            }
        };
        div.innerHTML = `<img src="${u.photoURL}" class="w-12 h-12 rounded-full mb-2 shadow-sm"><span class="text-xs font-bold text-slate-700">${u.displayName.split(' ')[0]}</span>`;
        list.appendChild(div);
    });
};

window.openChecklist = () => { document.getElementById('modal-checklist').classList.remove('hidden'); document.getElementById('btn-confirm-approve').disabled = true; document.querySelectorAll('.approval-check').forEach(c => c.checked = false); };
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.validateChecklist = () => { document.getElementById('btn-confirm-approve').disabled = !Array.from(document.querySelectorAll('.approval-check')).every(c => c.checked); };
window.executeApproval = () => { window.submitReview('Approved'); window.closeModal('modal-checklist'); };

window.submitReview = async (status) => {
    await updateDoc(doc(db, "projects", currentProject.id), { status: status });
    if (currentProject.creatorEmail) {
        const subject = status === 'Approved' ? `Approved: ${currentProject.title}` : `Edits Requested: ${currentProject.title}`;
        sendNotification(currentProject.creatorEmail, subject, `<p>Your project <b>${currentProject.title}</b> is now <b>${status}</b>.</p><p>Please check the Reviewer Notes tab in the app for details.</p>`);
    }
};

window.finalizeProject = async () => {
    if(!confirm("Archive and delete source file?")) return;
    try {
        if(currentProject.storagePath) await deleteObject(ref(storage, currentProject.storagePath));
        await updateDoc(doc(db, "projects", currentProject.id), { status: 'Archived', fileURL: null, archivedAt: serverTimestamp() });
        alert("Project Archived.");
        window.showDashboard();
    } catch(e) { alert(e.message); }
};

window.deleteProject = async (id, path) => {
    if(!confirm("⚠️ PERMANENT DELETE\nAre you sure you want to remove this project?")) return;
    try {
        await deleteDoc(doc(db, "projects", id));
        if(path) { try { await deleteObject(ref(storage, path)); } catch(e){} }
    } catch(e) { alert("Error: " + e.message); }
};

function hideAllViews() {
    ['view-login', 'view-dashboard', 'view-wizard', 'view-project', 'view-archived'].forEach(v => document.getElementById(v).classList.add('hidden'));
}