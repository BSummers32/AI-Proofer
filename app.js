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
provider.addScope('https://www.googleapis.com/auth/tasks');

// State
let currentUser = null;
let currentUserData = null; 
let currentProject = null;
let isRevisionMode = false;
let chatUnsubscribe = null; 
let fileToUpload = null;
let fileBase64 = null;

// --- UTILS: SHORT STATUS PILLS ---
const getStatusPill = (status) => {
    switch(status) {
        case 'Needs Review': return `<span class="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-1 rounded uppercase border border-blue-200">Review</span>`;
        case 'Changes Requested': return `<span class="bg-red-100 text-red-700 text-[10px] font-bold px-2 py-1 rounded uppercase border border-red-200">Revise</span>`;
        case 'Approved': return `<span class="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-1 rounded uppercase border border-emerald-200">Done</span>`;
        case 'Archived': return `<span class="bg-slate-100 text-slate-500 text-[10px] font-bold px-2 py-1 rounded uppercase border border-slate-200">Archived</span>`;
        default: return `<span class="bg-slate-100 text-slate-500 text-[10px] font-bold px-2 py-1 rounded uppercase border border-slate-200">Draft</span>`;
    }
};

// --- GOOGLE TASKS SERVICE ---
const TaskService = {
    async getAccessToken() { return sessionStorage.getItem('google_access_token'); },
    async ensureTaskList(token) {
        let listId = localStorage.getItem('pb_task_list_id');
        if (listId) return listId;
        try {
            const res = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', { headers: { Authorization: `Bearer ${token}` } });
            if(!res.ok) throw new Error("Failed to fetch lists");
            const data = await res.json();
            const existing = data.items.find(l => l.title === 'Proof Buddy');
            if (existing) { localStorage.setItem('pb_task_list_id', existing.id); return existing.id; }
            const createRes = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'Proof Buddy' })
            });
            const newList = await createRes.json();
            localStorage.setItem('pb_task_list_id', newList.id);
            return newList.id;
        } catch (e) { console.error("Task List Error:", e); return null; }
    },
    async createTask(title, dueDateStr) {
        const token = await this.getAccessToken();
        if (!token) { console.warn("No Google Task token found"); return; }
        const listId = await this.ensureTaskList(token);
        if (!listId) return;
        const payload = { title: title };
        if (dueDateStr) { const date = new Date(dueDateStr); date.setHours(9, 0, 0, 0); payload.due = date.toISOString(); }
        
        try {
            const res = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if(!res.ok) console.error("Failed to create task", await res.text());
            else console.log("Task created:", title);
        } catch(e) { console.error(e); }
    }
};

async function syncProjectTasks(projects) {
    if (!currentUser) return;
    for (const p of projects) {
        let actionNeeded = null;
        // Logic updated for arrays
        const isReviewer = (p.reviewerIds || []).includes(currentUser.uid);
        const isApprover = p.approverId === currentUser.uid;
        const isCreator = p.creatorId === currentUser.uid;

        if (isReviewer && p.status === 'Needs Review') actionNeeded = p.revisionCount > 0 ? 'Has been revised' : 'Needs review';
        else if (isApprover && p.status === 'Needs Review') actionNeeded = 'Needs Final Approval';
        else if (isCreator && p.status === 'Changes Requested') actionNeeded = 'Has comments';
        else if (isCreator && p.status === 'Approved') actionNeeded = 'Approved';

        if (actionNeeded) {
            const trackRef = doc(db, "users", currentUser.uid, "taskTracking", p.id);
            const trackSnap = await getDoc(trackRef);
            const trackData = trackSnap.data();
            if (!trackData || trackData.lastStatus !== p.status) {
                await TaskService.createTask(`${p.title} - ${actionNeeded}`, p.deadlineNext);
                await setDoc(trackRef, { lastStatus: p.status, updatedAt: serverTimestamp() });
            }
        }
    }
}

// --- GLOBAL BINDINGS ---
window.toggleSidebar = () => document.getElementById('sidebar').classList.toggle('collapsed');
window.toggleAllProjects = () => {
    const el = document.getElementById('container-all-projects');
    const arrow = document.getElementById('all-projects-arrow');
    el.classList.toggle('open');
    arrow.style.transform = el.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
};

window.signIn = () => {
    signInWithPopup(auth, provider).then((result) => {
        const token = GoogleAuthProvider.credentialFromResult(result).accessToken;
        if (token) sessionStorage.setItem('google_access_token', token);
    }).catch(e => { document.getElementById('login-error').innerText = e.message; document.getElementById('login-error').classList.remove('hidden'); });
};
window.logout = () => { sessionStorage.removeItem('google_access_token'); signOut(auth); };

window.showDashboard = () => { hideAllViews(); document.getElementById('view-dashboard').classList.remove('hidden'); loadDashboard(); };
window.showArchived = () => { hideAllViews(); document.getElementById('view-archived').classList.remove('hidden'); loadArchived(); };
window.switchTab = (tabId) => {
    ['tab-ai', 'tab-review', 'tab-chat'].forEach(t => document.getElementById(t).classList.add('hidden'));
    ['btn-tab-ai', 'btn-tab-review', 'btn-tab-chat'].forEach(b => document.getElementById(b).classList.remove('active'));
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById('btn-' + tabId).classList.add('active');
};

// --- FILE HANDLING & WIZARD ---
window.handleFilePreview = (input) => {
    if(input.files && input.files[0]) {
        fileToUpload = input.files[0];
        document.getElementById('file-preview-name').innerText = fileToUpload.name;
        if(fileToUpload.size > 5 * 1024 * 1024) document.getElementById('file-preview-name').innerText += " (Processing...)";
        const reader = new FileReader();
        reader.onload = (e) => {
            fileBase64 = e.target.result;
            document.getElementById('file-preview-name').innerText = fileToUpload.name; 
        };
        reader.readAsDataURL(fileToUpload);
    }
};

window.startUpload = (revisionMode = false) => {
    isRevisionMode = revisionMode;
    hideAllViews();
    document.getElementById('view-wizard').classList.remove('hidden');
    
    // RESET STATE
    fileToUpload = null;
    fileBase64 = null;
    document.getElementById('file-upload').value = '';
    document.getElementById('file-preview-name').innerText = "Click to upload document or video";
    document.getElementById('upload-status').classList.add('hidden'); 
    document.getElementById('btn-submit-project').disabled = false;

    // FIX FOR DATES
    if(isRevisionMode && currentProject) {
        document.getElementById('wizard-title').innerText = "Upload Revision";
        document.getElementById('input-title').value = currentProject.title; 
        document.getElementById('input-title').disabled = true;
        document.getElementById('type-group').classList.add('hidden');
        document.getElementById('context-group').classList.add('hidden');
        document.getElementById('btn-submit-project').innerText = "Verify Revision";
        
        document.getElementById('input-deadline-final').value = currentProject.deadlineFinal || '';
        document.getElementById('input-deadline-next').value = ''; 
    } else {
        document.getElementById('wizard-title').innerText = "Upload New Content";
        document.getElementById('input-title').value = "";
        document.getElementById('input-title').disabled = false;
        document.getElementById('type-group').classList.remove('hidden');
        document.getElementById('context-group').classList.remove('hidden');
        document.getElementById('btn-submit-project').innerText = "Analyze & Save Project";
        
        document.getElementById('input-deadline-final').value = ''; 
        document.getElementById('input-deadline-next').value = '';  
    }
};

window.submitProject = async () => {
    const title = document.getElementById('input-title').value;
    const btn = document.getElementById('btn-submit-project');
    const statusMsg = document.getElementById('upload-status');

    if(!fileToUpload) return alert("Please upload a file first.");
    if(!fileBase64) return alert("File is still processing.");

    btn.disabled = true;
    statusMsg.classList.remove('hidden');
    statusMsg.innerText = "Processing... Uploading File...";

    try {
        const mimeType = fileToUpload.type;
        const isImage = mimeType.startsWith('image/');
        const isPdf = mimeType === 'application/pdf';
        const isVideo = mimeType.startsWith('video/');
        const isBinary = isImage || isPdf || isVideo;

        const storageRef = ref(storage, `projects/${currentUser.uid}/${Date.now()}_${fileToUpload.name}`);
        await uploadString(storageRef, fileBase64, 'data_url');
        const url = await getDownloadURL(storageRef);

        statusMsg.innerText = "Processing... Analyzing with AI...";

        const payload = {
            mode: 'analyze',
            fileUrl: url,
            mediaType: isRevisionMode ? currentProject.mediaType : document.getElementById('input-type').value,
            mimeType: mimeType,
            isBinary: isBinary,
            targetAudience: document.getElementById('input-audience').value,
            priority: document.getElementById('input-priority').value
        };

        if(isRevisionMode && currentProject.aiSuggestions && currentProject.aiSuggestions.length > 0) {
            const accepted = currentProject.aiSuggestions.filter(s => s.status === 'accepted');
            if(accepted.length > 0) {
                payload.mode = 'verify';
                payload.expectedEdits = accepted;
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000); 

        let suggestions = [];
        try {
            const res = await fetch('/.netlify/functions/proof-read', { 
                method: 'POST', 
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if(!res.ok) throw new Error("AI Analysis Failed.");
            const data = await res.json();
            suggestions = Array.isArray(data) ? data : [];
            
            if(payload.mode === 'verify') {
                suggestions = suggestions.map((r, i) => ({
                    id: i, original: "Pending Fix", fix: r.fix, 
                    reason: r.status === 'verified' ? "✅ Verified Fix" : "❌ Fix Failed",
                    status: r.status === 'verified' ? 'accepted' : 'rejected'
                }));
            } else {
                suggestions = suggestions.map(s => ({...s, status: 'pending'}));
            }
        } catch(fetchError) {
             console.warn("AI Analysis skipped or failed", fetchError);
        }

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
                reviewerIds: [], // New: Array of reviewer UIDs
                approverId: null, // New: Single approver UID
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

async function sendNotification(email, subject, html) {
    if(!email) return;
    try {
        await fetch('/.netlify/functions/send-email', { method: 'POST', body: JSON.stringify({ to: email, subject, html }) });
    } catch(e) { console.error("Email failed", e); }
}

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        onSnapshot(doc(db, "users", user.uid), (docSnap) => {
            if (docSnap.exists()) { currentUserData = docSnap.data(); loadDashboard(); }
        });
        await setDoc(doc(db, "users", user.uid), { uid: user.uid, displayName: user.displayName, email: user.email, photoURL: user.photoURL, lastSeen: serverTimestamp() }, { merge: true });
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
    
    // FETCH 1: All Projects (for calculations & admin view)
    onSnapshot(query(collection(db, "projects")), (snapshot) => {
        const containerAll = document.getElementById('list-all-projects');
        const containerMy = document.getElementById('list-my-projects');
        containerAll.innerHTML = '';
        containerMy.innerHTML = '';
        
        const allDocs = [];
        let activeCount = 0;
        let dueThisWeek = 0;

        snapshot.forEach(doc => {
            const d = doc.data();
            if(d.status !== 'Archived') {
                allDocs.push({ id: doc.id, ...d });
                activeCount++;
                if(d.deadlineFinal) {
                    const due = new Date(d.deadlineFinal);
                    if(due >= firstDay && due <= lastDay) dueThisWeek++;
                }
            }
        });
        
        document.getElementById('stat-total').innerText = activeCount;
        document.getElementById('stat-due').innerText = dueThisWeek;
        allDocs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        
        // Render All Projects List
        if(allDocs.length === 0) containerAll.innerHTML = '<div class="p-4 text-center text-slate-400">No active projects.</div>';
        allDocs.forEach(data => renderTeamRow(data, data.id, containerAll, false));

        // Render Column 1: My Projects
        const myDocs = allDocs.filter(d => d.creatorId === currentUser.uid);
        if(myDocs.length === 0) containerMy.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">You haven\'t created any projects.</div>';
        myDocs.forEach(data => renderTeamRow(data, data.id, containerMy, true));

        syncProjectTasks(myDocs);
    });

    // FETCH 2: Assigned as Reviewer (FILTERED: Remove if also Approver)
    onSnapshot(query(collection(db, "projects"), where("reviewerIds", "array-contains", currentUser.uid)), (snapshot) => {
        const container = document.getElementById('list-assigned-reviewer');
        const badge = document.getElementById('badge-reviewer');
        container.innerHTML = '';
        let docs = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            // FILTER: If I am the approver, don't show here. Show in Approver col.
            if(d.status !== 'Archived' && d.status !== 'Approved' && d.approverId !== currentUser.uid) {
                docs.push({ id: doc.id, ...d });
            }
        });
        badge.innerText = docs.length;
        if(docs.length === 0) container.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">No reviews assigned.</div>';
        docs.forEach(data => renderCard(data, data.id, container, 'reviewer'));
    });

    // FETCH 3: Assigned as Approver
    onSnapshot(query(collection(db, "projects"), where("approverId", "==", currentUser.uid)), (snapshot) => {
        const container = document.getElementById('list-assigned-approver');
        const badge = document.getElementById('badge-approver');
        container.innerHTML = '';
        const docs = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            if(d.status !== 'Archived') docs.push({ id: doc.id, ...d });
        });
        badge.innerText = docs.length;
        if(docs.length === 0) container.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">No approvals pending.</div>';
        docs.forEach(data => renderCard(data, data.id, container, 'approver'));
    });
}

// FIX: New function to load archived projects
async function loadArchived() {
    if(!currentUser) return;
    const q = query(collection(db, "projects"), where("status", "==", "Archived"), orderBy("archivedAt", "desc"));
    onSnapshot(q, (snap) => {
        const container = document.getElementById('list-archived-docs');
        container.innerHTML = '';
        if(snap.empty) {
            container.innerHTML = '<div class="p-8 text-center text-slate-400">No archived projects.</div>';
            return;
        }
        snap.forEach(doc => {
            renderTeamRow(doc.data(), doc.id, container, false);
        });
    });
}

function renderTeamRow(data, id, container, isMyProjectView) {
    const div = document.createElement('div');
    div.className = "grid grid-cols-12 px-5 py-4 border-b border-slate-100 hover:bg-slate-50 items-center transition group cursor-pointer relative";
    
    const statusPill = getStatusPill(data.status);
    
    let revisionText = data.revisionCount > 0 ? `${data.revisionCount} Revision` : "Original";
    let priorityBadge = data.priority === "Urgent" ? `<span class="text-red-600 font-bold text-xs uppercase">🔥 Urgent</span>` : 
                        data.priority === "High" ? `<span class="text-orange-500 font-bold text-xs">High</span>` : 
                        `<span class="text-slate-400 text-xs">Normal</span>`;

    // FIX: Show both dates
    const nextDate = data.deadlineNext ? new Date(data.deadlineNext).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    const finalDate = data.deadlineFinal ? new Date(data.deadlineFinal).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    
    const isOwner = data.creatorId === currentUser.uid;
    
    // FIX: Delete button StopPropagation
    const deleteBtn = isOwner ? 
        `<button onclick="event.stopPropagation(); window.deleteProject('${id}', '${data.storagePath || ''}')" class="text-slate-300 hover:text-red-500 p-1.5 rounded hover:bg-red-50 transition z-10 relative"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>` : `<div class="w-8"></div>`;

    let notifyDot = '';
    if(isMyProjectView && data.status === 'Changes Requested') {
        notifyDot = `<span class="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white"></span>`;
    }

    div.onclick = () => window.loadProject(id);

    div.innerHTML = `
        <div class="col-span-1 text-center" onclick="event.stopPropagation()">${deleteBtn}</div>
        <div class="col-span-4 relative">
            <div class="flex items-center gap-2 relative inline-block">
                <div class="font-bold text-slate-700 text-sm truncate pr-2">${data.title}</div>
                ${notifyDot}
            </div>
            <div class="text-[10px] text-slate-400 mt-0.5 font-bold uppercase tracking-wide">${data.mediaType} • ${revisionText}</div>
        </div>
        <div class="col-span-2">${statusPill}</div>
        <div class="col-span-2">${priorityBadge}</div>
        <div class="col-span-1 flex items-center gap-2">
            <img src="${data.creatorPhoto}" class="w-6 h-6 rounded-full border border-white shadow-sm" title="${data.creatorName}">
        </div>
        <div class="col-span-2 text-right">
             <div class="text-[10px] text-slate-500 font-bold">Next: ${nextDate}</div>
             <div class="text-[10px] text-slate-400">Final: ${finalDate}</div>
        </div>
    `;
    container.appendChild(div);
}

function renderCard(data, id, container, type) {
    const div = document.createElement('div');
    const bgClass = type === 'approver' ? 'bg-white/10 hover:bg-white/15' : 'bg-white border-slate-100 hover:shadow-md';
    const textClass = type === 'approver' ? 'text-white' : 'text-slate-800';
    const subTextClass = type === 'approver' ? 'text-slate-400' : 'text-slate-500';

    div.className = `${bgClass} p-4 rounded-xl border border-transparent transition cursor-pointer group relative mb-3`;
    div.onclick = () => window.loadProject(id);
    
    let badge = data.priority === "Urgent" ? `<span class="bg-red-500/20 text-red-400 text-[10px] font-bold px-2 py-0.5 rounded uppercase border border-red-500/30">Urgent 🔥</span>` : "";
    
    // Dates
    const nextDate = data.deadlineNext ? new Date(data.deadlineNext).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';
    const finalDate = data.deadlineFinal ? new Date(data.deadlineFinal).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '-';

    div.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <div class="flex items-center gap-2">${badge}</div>
            <span class="text-emerald-400 font-bold text-[10px] uppercase ml-2">${data.status}</span>
        </div>
        <h4 class="font-bold text-sm mb-3 ${textClass} truncate">${data.title}</h4>
        <div class="flex justify-between items-end mb-2">
            <div class="text-xs ${subTextClass}">Owner: <span class="font-bold">${data.creatorName.split(' ')[0]}</span></div>
            <div class="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold text-white shadow-lg shadow-emerald-500/50">${data.creatorName[0]}</div>
        </div>
        <div class="flex justify-between items-center pt-2 border-t ${type==='approver' ? 'border-white/10' : 'border-slate-100'} text-[10px] ${subTextClass}">
            <span>Goal: ${nextDate}</span>
            <span>Final: ${finalDate}</span>
        </div>
    `;
    container.appendChild(div);
}

window.loadProject = async (id) => {
    hideAllViews();
    if(chatUnsubscribe) { chatUnsubscribe(); chatUnsubscribe = null; }
    document.getElementById('view-project').classList.remove('hidden');
    
    if (currentUser) setDoc(doc(db, "users", currentUser.uid), { projectViews: { [id]: serverTimestamp() } }, { merge: true });

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
    
    if(p.status === 'Archived') {
        docContainer.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-slate-400"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mb-4"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg><p class="text-lg font-bold">File Deleted (Archived)</p><p class="text-sm">Metadata, notes, and chat are preserved.</p></div>';
        diffContainer.classList.add('hidden');
        diffMsg.classList.add('hidden');
    } else {
        docContainer.classList.remove('hidden');
        diffContainer.classList.add('hidden');
        diffMsg.classList.add('hidden');

        if(p.fileMime.startsWith('image/')) {
            docContainer.innerHTML = `<img src="${p.fileURL}" class="max-w-full h-auto mx-auto shadow-lg rounded">`;
        } else if(p.fileMime === 'application/pdf') {
            docContainer.innerHTML = `<iframe src="${p.fileURL}" class="w-full h-full border-0 rounded"></iframe>`;
        } else if(p.fileMime.startsWith('video/')) {
            docContainer.innerHTML = `<div class="bg-black rounded-xl overflow-hidden shadow-lg w-full flex justify-center"><video controls src="${p.fileURL}" class="max-h-[600px] max-w-full"></video></div>`;
        } else {
            docContainer.innerHTML = `<div class="p-8 text-center"><a href="${p.fileURL}" target="_blank" class="text-blue-500 underline">Download File</a></div>`;
        }
    }

    // ROLES
    const isReviewer = (p.reviewerIds || []).includes(currentUser.uid);
    const isApprover = p.approverId === currentUser.uid;
    const isCreator = p.creatorId === currentUser.uid;
    // FIX: ensure buttons show for any of these roles
    const canEdit = (isCreator || isReviewer || isApprover) && p.status !== 'Approved' && p.status !== 'Archived';
    
    // AI Suggestions List
    const aiList = document.getElementById('ai-feedback-list');
    aiList.innerHTML = '';
    if(!p.aiSuggestions || p.aiSuggestions.length === 0) aiList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No AI suggestions found.</div>';
    
    (p.aiSuggestions || []).forEach((s, idx) => {
        const isRejected = s.status === 'rejected';
        const isAccepted = s.status === 'accepted';
        const accentColor = isRejected ? 'bg-red-400' : isAccepted ? 'bg-emerald-500' : 'bg-slate-300';
        const badgeColor = isRejected ? 'text-red-600 bg-red-50' : isAccepted ? 'text-emerald-600 bg-emerald-50' : 'text-slate-500 bg-slate-100';
        const badgeText = s.status === 'pending' ? 'Suggestion' : s.status;

        // VOTING BUTTONS: Allow toggling
        const actionButtons = canEdit ? `
            <div class="mt-4 flex gap-2">
                <button onclick="updateSuggestion(${idx}, 'accepted')" class="flex-1 ${isAccepted ? 'bg-emerald-600' : 'bg-slate-900'} text-white py-2 rounded-lg text-xs font-bold hover:bg-emerald-500 transition shadow-md shadow-slate-200">
                   ${isAccepted ? '✓ Accepted' : 'Accept'}
                </button>
                <button onclick="updateSuggestion(${idx}, 'rejected')" class="flex-1 ${isRejected ? 'bg-red-600 text-white' : 'bg-white text-slate-400 border border-slate-200'} py-2 rounded-lg text-xs font-bold hover:bg-red-500 hover:text-white transition">
                   ${isRejected ? '✕ Rejected' : 'Reject'}
                </button>
            </div>
        ` : '';

        aiList.innerHTML += `
        <div class="bg-white rounded-xl shadow-md border border-slate-100 overflow-hidden flex transition hover:shadow-lg mb-4">
            <div class="w-2 ${accentColor} shrink-0"></div>
            <div class="flex-1 p-5">
                <div class="flex justify-between items-start mb-3">
                    <span class="text-[10px] font-bold uppercase tracking-wider ${badgeColor} px-2 py-1 rounded-md">
                        ${badgeText}
                    </span>
                </div>
                <p class="text-slate-600 text-sm leading-snug mb-4">${s.reason}</p>
                <div class="space-y-1">
                    <div class="text-xs text-slate-400 line-through decoration-red-300 decoration-2 px-3 py-1">${s.original}</div>
                    <div class="bg-emerald-50 text-emerald-900 text-sm font-bold px-3 py-3 rounded-lg border-l-2 border-emerald-500 shadow-sm">${s.fix}</div>
                </div>
                ${actionButtons}
            </div>
        </div>`;
    });

    // Manual Notes
    const manualList = document.getElementById('manual-feedback-list');
    manualList.innerHTML = '';
    if(!p.reviewerSuggestions || p.reviewerSuggestions.length === 0) manualList.innerHTML = '<div class="text-center text-sm text-slate-400 mt-4">No reviewer notes yet.</div>';
    (p.reviewerSuggestions || []).forEach((s, idx) => {
        const isChecked = s.acknowledged ? 'checked' : '';
        const opacity = s.acknowledged ? 'opacity-50' : 'opacity-100';
        const checkbox = isCreator ? `<input type="checkbox" ${isChecked} onclick="toggleManualNote(${idx})" class="w-5 h-5 text-blue-600 rounded cursor-pointer mr-3">` : '';

        manualList.innerHTML += `
            <div class="suggestion-card p-5 mb-4 status-manual flex items-start ${opacity} transition">
                ${checkbox}
                <div class="flex-1">
                    <div class="flex justify-between items-start mb-2"><span class="text-sm font-bold text-slate-800 leading-tight">${s.reason}</span><span class="text-[10px] font-bold text-blue-500 uppercase ml-2">Note</span></div>
                    <div class="diff-block">${s.original ? `<div class="diff-old">${s.original}</div>` : ''}${s.fix ? `<div class="diff-new">${s.fix}</div>` : ''}</div>
                </div>
            </div>`;
    });

    // ACTION BUTTON LOGIC
    document.getElementById('manual-note-form').classList.add('hidden');
    const actions = document.getElementById('action-buttons');
    actions.innerHTML = '';
    
    if(isCreator) {
        if(p.status === 'Draft') actions.innerHTML = `<button onclick="openAssignModal()" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Assign Team</button>`;
        if(p.status === 'Changes Requested') actions.innerHTML = `<button onclick="startUpload(true)" class="bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Upload Revision</button>`;
    } 
    
    // Reviewers AND Approvers can request changes
    if((isReviewer || isApprover) && p.status === 'Needs Review') {
        document.getElementById('manual-note-form').classList.remove('hidden');
        actions.innerHTML = `<button onclick="submitReview('Changes Requested')" class="bg-white border border-red-200 text-red-600 px-4 py-2 rounded-lg text-sm font-bold hover:bg-red-50 transition">Request Changes</button>`;
        
        // Only Approver can approve finally
        if(isApprover) {
            actions.innerHTML += `<button onclick="openChecklist()" class="ml-2 bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-600 transition shadow-md">Final Approval</button>`;
        }
    }

    // Only Approver can Final Commit (Archive)
    if(p.status === 'Approved' && isApprover) {
        actions.innerHTML = `<button onclick="finalizeProject()" class="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-slate-900 transition shadow-lg">Final Commit & Archive</button>`;
    }
}

window.updateSuggestion = async (i, s) => {
    // Allows toggling states
    const newS = [...currentProject.aiSuggestions];
    newS[i].status = s;
    await updateDoc(doc(db, "projects", currentProject.id), { aiSuggestions: newS });
};

window.toggleManualNote = async (idx) => {
    if(!currentProject) return;
    const notes = [...currentProject.reviewerSuggestions];
    notes[idx].acknowledged = !notes[idx].acknowledged;
    await updateDoc(doc(db, "projects", currentProject.id), { reviewerSuggestions: notes });
};

window.addManualSuggestion = async () => {
    const reason = document.getElementById('manual-reason').value;
    const original = document.getElementById('manual-original').value;
    const fix = document.getElementById('manual-fix').value;
    if(!reason) return alert("Please enter a summary or reason.");
    try {
        const newNote = { reason, original, fix, createdAt: Date.now(), creatorId: currentUser.uid, acknowledged: false };
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
        await setDoc(doc(db, "users", currentUser.uid), { projectViews: { [currentProject.id]: serverTimestamp() } }, { merge: true });
        input.value = '';
    } catch(err) { console.error("Chat error:", err); }
};

// --- NEW ASSIGNMENT LOGIC ---
let tempReviewers = new Set();
let tempApprover = null;

window.openAssignModal = async () => {
    document.getElementById('modal-assign').classList.remove('hidden');
    
    // Reset temps
    tempReviewers.clear();
    tempApprover = null;
    
    const listReviewers = document.getElementById('list-reviewers');
    const listApprovers = document.getElementById('list-approvers');
    listReviewers.innerHTML = 'Loading...';
    listApprovers.innerHTML = 'Loading...';
    
    const snaps = await getDocs(collection(db, "users"));
    listReviewers.innerHTML = '';
    listApprovers.innerHTML = '';
    
    snaps.forEach(s => {
        const u = s.data();
        if(u.uid === currentUser.uid) return; 

        // Render Reviewer Checkbox
        const divR = document.createElement('div');
        divR.className = "flex items-center gap-3 p-3 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 border border-slate-100";
        divR.onclick = (e) => {
            // Toggle
            const cb = divR.querySelector('input');
            cb.checked = !cb.checked;
            if(cb.checked) tempReviewers.add(u.uid); else tempReviewers.delete(u.uid);
        };
        divR.innerHTML = `
            <input type="checkbox" value="${u.uid}" class="w-5 h-5 text-blue-600 rounded pointer-events-none">
            <div class="flex items-center gap-2">
                <img src="${u.photoURL}" class="w-8 h-8 rounded-full bg-slate-200">
                <span class="text-sm font-bold text-slate-700">${u.displayName.split(' ')[0]}</span>
            </div>
        `;
        listReviewers.appendChild(divR);

        // Render Approver Radio
        const divA = document.createElement('div');
        divA.className = "flex items-center gap-3 p-3 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 border border-slate-100";
        divA.onclick = () => {
             // Handle UI selection for radio behavior
             document.querySelectorAll('input[name="approver-radio"]').forEach(r => r.checked = false);
             divA.querySelector('input').checked = true;
             tempApprover = u.uid;
        };
        divA.innerHTML = `
            <input type="radio" name="approver-radio" value="${u.uid}" class="w-5 h-5 text-emerald-600 pointer-events-none">
            <div class="flex items-center gap-2">
                <img src="${u.photoURL}" class="w-8 h-8 rounded-full bg-slate-200">
                <span class="text-sm font-bold text-slate-700">${u.displayName.split(' ')[0]}</span>
            </div>
        `;
        listApprovers.appendChild(divA);
    });
};

window.saveAssignments = async () => {
    if(!tempApprover) return alert("Please select one Final Approver.");
    
    await updateDoc(doc(db, "projects", currentProject.id), { 
        reviewerIds: Array.from(tempReviewers),
        approverId: tempApprover,
        status: 'Needs Review' 
    });
    
    window.closeModal('modal-assign');
};

window.openChecklist = () => { document.getElementById('modal-checklist').classList.remove('hidden'); document.getElementById('btn-confirm-approve').disabled = true; document.querySelectorAll('.approval-check').forEach(c => c.checked = false); };
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.validateChecklist = () => { document.getElementById('btn-confirm-approve').disabled = !Array.from(document.querySelectorAll('.approval-check')).every(c => c.checked); };
window.executeApproval = () => { window.submitReview('Approved'); window.closeModal('modal-checklist'); };

window.submitReview = async (status) => {
    await updateDoc(doc(db, "projects", currentProject.id), { status: status });
    // Notify Creator
    if (currentProject.creatorEmail) {
        sendNotification(currentProject.creatorEmail, `Project Update: ${status}`, `<p>Your project <b>${currentProject.title}</b> is now <b>${status}</b>.</p>`);
    }
};

window.finalizeProject = async () => {
    if(!confirm("Archive and delete source file? Metadata and chat will be preserved.")) return;
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