// ============================================================
// HABIT TRACKER - Frontend JavaScript
// Kết nối với Google Apps Script API
// ============================================================

// ⚙️ CONFIG
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbxLR1r42Jr6Ltn981HN1EsZdxsRZhwpR2Jkv_1-Ssw0Cw1kpaHadc9sNo7SRO-vwi7B/exec';

// 📡 DEFAULT_SHEET_ID: Paste Spreadsheet ID vào đây (cùng ID trong Code.gs)
// ID này KHÔNG BAO GIỜ thay đổi → mọi thiết bị tự tìm API URL từ Google Sheets.
// Lấy từ URL Google Sheets: https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
const DEFAULT_SHEET_ID = '1K3_B5HTbZNhUlBYUG8FBPWB56Zqlv2ntuW68-EEmw5Q';

let API_URL = localStorage.getItem('habitflow_api_url') || DEFAULT_API_URL || '';
let displayName = localStorage.getItem('habitflow_name') || 'Người dùng';

// 🔄 Auto-update: nếu DEFAULT_API_URL thay đổi (deploy mới) → cập nhật localStorage
// Giải quyết: điện thoại vẫn giữ URL cũ trong localStorage sau khi deploy lại GAS
if (DEFAULT_API_URL && API_URL !== DEFAULT_API_URL) {
    const savedDefault = localStorage.getItem('habitflow_last_default_url');
    if (savedDefault !== DEFAULT_API_URL) {
        // DEFAULT_API_URL đã thay đổi → cập nhật
        API_URL = DEFAULT_API_URL;
        localStorage.setItem('habitflow_api_url', DEFAULT_API_URL);
        localStorage.setItem('habitflow_last_default_url', DEFAULT_API_URL);
        console.log('🔄 Auto-updated API URL to new deployment:', DEFAULT_API_URL);
    }
}

// 📡 SPREADSHEET ID - dùng để auto-discovery API URL
let SHEET_ID = localStorage.getItem('habitflow_sheet_id') || DEFAULT_SHEET_ID || '';

// ============================================================
// 🔍 AUTO-DISCOVERY: Đọc API URL từ Google Sheets trực tiếp
// Spreadsheet ID không bao giờ thay đổi → link này vĩnh viễn.
// Sử dụng Google Visualization API (public endpoint).
// ============================================================
async function discoverApiUrl(sheetId) {
    if (!sheetId) return null;
    try {
        const gvizUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=Settings`;
        const res = await fetch(gvizUrl);
        if (!res.ok) throw new Error('Sheet not accessible');
        const text = await res.text();
        // Parse CSV: tìm dòng "latestApiUrl","https://..."
        const match = text.match(/"latestApiUrl"\s*,\s*"(https:\/\/[^"]+)"/);
        if (match) {
            console.log('🔍 Auto-discovered API URL from Sheets:', match[1]);
            return match[1];
        }
    } catch (err) {
        console.log('🔍 API discovery failed:', err.message);
    }
    return null;
}

// State toàn cục
const state = {
    habits: [],
    completions: [],
    journal: [], // Daily journal entries
    stats: null,
    viewMode: 'monthly', // 'monthly' | 'weekly'
    currentDate: new Date(),
    editingHabitId: null,
    unlockedBadges: [], // Danh sách badge đã mở khóa
};

// ============================================================
// 🏆 GAMIFICATION - BADGES DEFINITIONS
// ============================================================
const BADGES = [
    { id: 'first_step', name: 'Bước đầu tiên', icon: '🐣', desc: 'Hoàn thành thói quen đầu tiên', goal: 1 },
    { id: 'streak_7', name: 'Chiến binh 7 ngày', icon: '🔥', desc: 'Đạt chuỗi 7 ngày liên tiếp', goal: 7 },
    { id: 'consistency_pro', name: 'Thần chuyên cần', icon: '👑', desc: 'Điểm chuyên cần >= 90%', goal: 90 },
    { id: 'habit_master', name: 'Bậc thầy thói quen', icon: '🧙‍♂️', desc: 'Hoàn thành 100 lần', goal: 100 },
    { id: 'multi_tasker', name: 'Người đa năng', icon: '🎭', desc: 'Theo dõi 5+ thói quen cùng lúc', goal: 5 }
];

// ============================================================
// 💾 LOCALSTORAGE CACHE
// Mọi thay đổi được lưu cache NGAY LẬP TỨC.
// Khi mở lại trang → hiển thị từ cache trước, API cập nhật ngầm.
// ============================================================
const CACHE_KEYS = {
    habits: 'habitflow_habits',
    completions: 'habitflow_completions',
    stats: 'habitflow_stats',
    journal: 'habitflow_journal',
};

function saveCache() {
    try {
        localStorage.setItem(CACHE_KEYS.habits, JSON.stringify(state.habits));
        localStorage.setItem(CACHE_KEYS.completions, JSON.stringify(state.completions));
        localStorage.setItem(CACHE_KEYS.journal, JSON.stringify(state.journal));
        if (state.stats) localStorage.setItem(CACHE_KEYS.stats, JSON.stringify(state.stats));
    } catch (e) { /* quota exceeded – ignore */ }
}

function loadCache() {
    try {
        const h = localStorage.getItem(CACHE_KEYS.habits);
        const c = localStorage.getItem(CACHE_KEYS.completions);
        const s = localStorage.getItem(CACHE_KEYS.stats);
        const j = localStorage.getItem(CACHE_KEYS.journal);
        if (h) state.habits = JSON.parse(h);
        if (c) state.completions = JSON.parse(c);
        if (s) state.stats = JSON.parse(s);
        if (j) state.journal = JSON.parse(j);
        const b = localStorage.getItem('habitflow_badges');
        if (b) state.unlockedBadges = JSON.parse(b);
        return !!(h || c); // true nếu có cache
    } catch (e) { return false; }
}

// ============================================================
// 📤 API SYNC QUEUE
// Đảm bảo mọi tick đều được gửi lên Sheets theo thứ tự.
// Nếu đang gửi thì xếp hàng, không mất tick nào.
// ⚡ Queue được lưu vào localStorage để không mất khi refresh.
// ============================================================
const syncQueue = (() => {
    try {
        const saved = localStorage.getItem('habitflow_sync_queue');
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
})();
let syncRunning = false;

function saveSyncQueue() {
    try {
        localStorage.setItem('habitflow_sync_queue', JSON.stringify(syncQueue));
    } catch { /* quota exceeded */ }
}

// 📝 Journal Sync Queue - retry failed journal saves
let journalSyncQueue = (() => {
    try {
        const saved = localStorage.getItem('habitflow_journal_sync_queue');
        return saved ? JSON.parse(saved) : [];
    } catch { return []; }
})();

function saveJournalSyncQueue() {
    try {
        localStorage.setItem('habitflow_journal_sync_queue', JSON.stringify(journalSyncQueue));
    } catch { /* quota exceeded */ }
}

function enqueueJournalSync(date, mood, content) {
    // Replace existing entry for same date in queue
    const idx = journalSyncQueue.findIndex(q => q.date === date);
    if (idx >= 0) {
        journalSyncQueue[idx] = { date, mood, content };
    } else {
        journalSyncQueue.push({ date, mood, content });
    }
    saveJournalSyncQueue();
}

async function processJournalSyncQueue() {
    if (!API_URL || journalSyncQueue.length === 0) return;
    console.log(`📝 Retrying ${journalSyncQueue.length} pending journal entries...`);

    const toRetry = [...journalSyncQueue];
    for (const item of toRetry) {
        try {
            await apiPost({
                action: 'saveJournal',
                date: item.date,
                mood: item.mood,
                content: item.content
            });
            // Remove from queue after success
            const qIdx = journalSyncQueue.findIndex(q => q.date === item.date);
            if (qIdx >= 0) journalSyncQueue.splice(qIdx, 1);
            saveJournalSyncQueue();

            // Remove _local flag from state
            const sIdx = state.journal.findIndex(j => j.date === item.date);
            if (sIdx >= 0) delete state.journal[sIdx]._local;
            saveCache();
            console.log(`✅ Journal synced: ${item.date}`);
        } catch (err) {
            console.log(`⚠️ Journal sync failed for ${item.date}: ${err.message}`);
            break; // Stop on first error, retry later
        }
    }
}

function enqueuSync(habitId, date) {
    // Nếu đã có trong queue chờ (chưa gửi) thì toggle lại (hủy)
    const pendingIdx = syncQueue.findIndex(q => q.habitId === habitId && q.date === date);
    if (pendingIdx >= 0) {
        syncQueue.splice(pendingIdx, 1); // hủy bỏ – hai lần toggle = không đổi
    } else {
        syncQueue.push({ habitId, date });
    }
    saveSyncQueue();
    processSyncQueue();
}

async function processSyncQueue() {
    if (syncRunning || syncQueue.length === 0 || !API_URL) return;
    syncRunning = true;
    while (syncQueue.length > 0) {
        const item = syncQueue[0]; // peek, don't remove yet
        try {
            await apiPost({ action: 'toggleCompletion', habitId: item.habitId, date: item.date });
            syncQueue.shift(); // remove only after success
            saveSyncQueue();
        } catch (err) {
            // Kết nối lỗi: giữ item trong queue để retry sau
            showToast('⚠️ Mất kết nối – dữ liệu đã lưu offline, sẽ đồng bộ sau.', 'error');
            saveSyncQueue();
            break; // Stop processing, retry later
        }
    }
    syncRunning = false;
    // Refresh stats sau khi sync xong
    if (syncQueue.length === 0) refreshStatsBackground();
}

async function refreshStatsBackground() {
    if (!API_URL) return;
    try {
        const s = await apiGet({ action: 'getStats' });
        if (s.success) {
            state.stats = s.stats;
            saveCache();
            renderStats();
            updateXP();
        }
    } catch { /* silent */ }
}

// Mỗi ngày trong tháng hiển thị 1 câu khác nhau (chọn theo ngày)
const QUOTES = [
    { text: 'Thói quen tốt là chìa khóa của mọi thành công.', author: 'Og Mandino' },
    { text: 'Mỗi ngày một chút, theo thời gian bạn sẽ thấy sự thay đổi lớn lao.', author: 'Khuyết danh' },
    { text: 'Không phải động lực tạo nên thói quen, mà là thói quen tạo ra động lực.', author: 'Khuyết danh' },
    { text: 'Một năm từ bây giờ, bạn sẽ mong đã bắt đầu hôm nay.', author: 'Karen Lamb' },
    { text: 'Thành công là kết quả của những thói quen nhỏ được thực hiện liên tục.', author: 'James Clear' },
    { text: 'Hãy cẩn thận với những gì bạn lặp đi lặp lại, vì đó là con người bạn.', author: 'Aristotle' },
    { text: 'Chúng ta là những gì chúng ta liên tục làm. Vì vậy, xuất sắc không phải là hành động mà là thói quen.', author: 'Aristotle' },
    { text: 'Kỷ luật là cây cầu nối giữa ước mơ và thành tựu.', author: 'Jim Rohn' },
    { text: 'Đừng chờ cảm hứng. Nó trốn bạn vì bạn không hành động. Hành động trước, cảm hứng sẽ theo sau.', author: 'Jack London' },
    { text: 'Hành trình ngàn dặm bắt đầu từ một bước chân.', author: 'Lão Tử' },
    { text: 'Mỗi buổi sáng bạn có hai lựa chọn: tiếp tục ngủ với những giấc mơ, hoặc thức dậy và theo đuổi chúng.', author: 'Khuyết danh' },
    { text: 'Không có bí quyết nào dẫn đến thành công. Đó là kết quả của sự chuẩn bị, làm việc chăm chỉ và học hỏi từ thất bại.', author: 'Colin Powell' },
    { text: 'Người thành công không làm những điều khác biệt, họ làm những điều thông thường theo cách khác biệt.', author: 'Booker T. Washington' },
    { text: 'Bạn không cần phải vĩ đại để bắt đầu, nhưng bạn phải bắt đầu để trở nên vĩ đại.', author: 'Zig Ziglar' },
    { text: 'Điều quan trọng nhất là không bao giờ ngừng đặt câu hỏi.', author: 'Albert Einstein' },
    { text: 'Sự kiên nhẫn, sự bền bỉ và mồ hôi tạo thành một công thức bất khả chiến bại cho sự thành công.', author: 'Napoleon Hill' },
    { text: 'Kẻ thắng không bao giờ từ bỏ; kẻ từ bỏ không bao giờ thắng.', author: 'Vince Lombardi' },
    { text: 'Cuộc sống không phải là chờ đợi cơn bão qua đi— mà là học cách khiêu vũ dưới mưa.', author: 'Vivian Greene' },
    { text: 'Thay đổi thói quen, thay đổi cuộc đời.', author: 'Jack Canfield' },
    { text: 'Đầu tư tốt nhất bạn có thể thực hiện là đầu tư vào chính bản thân mình.', author: 'Warren Buffett' },
    { text: 'Sáng tạo là thông minh biết cách vui đùa.', author: 'Albert Einstein' },
    { text: 'Nếu bạn muốn sống một cuộc đời hạnh phúc, hãy gắn nó với một mục tiêu, không phải với con người hay đồ vật.', author: 'Albert Einstein' },
    { text: 'Thành công thường đến với những người quá bận rộn để tìm kiếm nó.', author: 'Henry David Thoreau' },
    { text: 'Hãy là sự thay đổi mà bạn muốn thấy trên thế giới.', author: 'Mahatma Gandhi' },
    { text: 'Tương lai thuộc về những ai tin vào vẻ đẹp của ước mơ.', author: 'Eleanor Roosevelt' },
    { text: 'Cách tốt nhất để dự đoán tương lai là tự tạo ra nó.', author: 'Peter Drucker' },
    { text: 'Nếu bạn không xây dựng giấc mơ của mình, ai đó sẽ thuê bạn để xây dựng giấc mơ của họ.', author: 'Tony Gaskins' },
    { text: 'Mỗi chuyên gia từng một lần là người mới bắt đầu. Mỗi người giỏi từng một lần là người không giỏi.', author: 'Robin Sharma' },
    { text: 'Đừng đếm những ngày, hãy làm cho những ngày đáng nhớ.', author: 'Muhammad Ali' },
    { text: 'Hạnh phúc không phải là thứ làm sẵn. Nó đến từ hành động của chính bạn.', author: 'Đạt Lai Lạt Ma' },
    { text: 'Năng lực của bạn để học hỏi và thích nghi là tài sản quý giá nhất bạn có.', author: 'Brian Tracy' },
];


// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    // 🔗 AUTO-CONFIG VIA URL PARAMS
    const urlParams = new URLSearchParams(window.location.search);

    // Cách 1: ?api=URL (link trực tiếp với API URL)
    const apiFromUrl = urlParams.get('api');
    if (apiFromUrl) {
        API_URL = apiFromUrl;
        localStorage.setItem('habitflow_api_url', apiFromUrl);
        console.log('🔗 Auto-configured API from URL param:', apiFromUrl);
    }

    // Cách 2: ?sid=SPREADSHEET_ID (link vĩnh viễn, tự đọc API URL từ Sheets)
    const sidFromUrl = urlParams.get('sid');
    if (sidFromUrl) {
        SHEET_ID = sidFromUrl;
        localStorage.setItem('habitflow_sheet_id', sidFromUrl);
        console.log('📡 Saved Spreadsheet ID from URL:', sidFromUrl);
    }

    // Xóa params khỏi URL (giữ URL sạch)
    if (apiFromUrl || sidFromUrl) {
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }

    // 🔍 AUTO-DISCOVERY: Nếu chưa có API URL → thử đọc từ Google Sheets
    if (!API_URL && SHEET_ID) {
        showLoading(true);
        const discovered = await discoverApiUrl(SHEET_ID);
        if (discovered) {
            API_URL = discovered;
            localStorage.setItem('habitflow_api_url', discovered);
            showToast('🔍 Đã tự động tìm thấy API URL!', 'success');
        }
        showLoading(false);
    }

    // 🔑 Fallback: DEFAULT_API_URL
    if (!API_URL && DEFAULT_API_URL) {
        localStorage.setItem('habitflow_api_url', DEFAULT_API_URL);
        API_URL = DEFAULT_API_URL;
    }

    initUI();
    initSettings();
    loadData();
    initAutoUpdate();
});

function initUI() {
    // Today's date (Sidebar & Dashboard Header)
    const today = new Date();
    const dateStrVi = formatDateVi(today);
    document.getElementById('todayDate').textContent = dateStrVi;

    const dashDate = document.getElementById('dashTodayDate');
    if (dashDate) dashDate.textContent = dateStrVi;

    // Greeting logic
    const hour = today.getHours();
    let greeting = 'Chào ngày mới';
    if (hour < 12) greeting = 'Chào buổi sáng';
    else if (hour < 18) greeting = 'Chào buổi chiều';
    else greeting = 'Chào buổi tối';

    const greetingEl = document.getElementById('greetingMsg');
    if (greetingEl) {
        const userName = localStorage.getItem('habitflow_user_name') || 'Người dùng';
        greetingEl.innerHTML = `${greeting}, <span class="user-name-val">${userName}</span>! 👋`;
    }

    // Câu nói theo ngày
    const dayIndex = (today.getDate() - 1) % QUOTES.length;
    const q = QUOTES[dayIndex];
    const quoteEl = document.getElementById('dailyQuote');
    if (quoteEl) quoteEl.textContent = `"${q.text}"`;
    const authorEl = document.getElementById('dailyQuoteAuthor');
    if (authorEl) authorEl.textContent = `— ${q.author}`;


    // Navigation
    document.querySelectorAll('.nav-item[data-page]').forEach(el => {
        el.addEventListener('click', e => {
            e.preventDefault();
            showPage(el.dataset.page);
        });
    });

    // Mobile menu
    document.getElementById('menuBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.add('open');
        document.getElementById('overlay').classList.add('show');
    });
    document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
    document.getElementById('overlay').addEventListener('click', closeSidebar);

    // View switch
    document.getElementById('btnMonthly').addEventListener('click', () => setView('monthly'));
    document.getElementById('btnWeekly').addEventListener('click', () => setView('weekly'));

    // Calendar navigation
    document.getElementById('prevPeriod').addEventListener('click', () => navigatePeriod(-1));
    document.getElementById('nextPeriod').addEventListener('click', () => navigatePeriod(1));
    document.getElementById('gotoToday').addEventListener('click', () => {
        state.currentDate = new Date();
        renderCalendar();
    });

    // Add habit
    document.getElementById('openAddHabit').addEventListener('click', () => openHabitModal());
    document.getElementById('openAddHabit2').addEventListener('click', () => openHabitModal());
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelModal').addEventListener('click', closeModal);
    document.getElementById('confirmHabit').addEventListener('click', saveHabit);

    // Emoji picker
    document.querySelectorAll('.emoji-opt').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('.emoji-opt').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
            document.getElementById('habitIcon').value = el.dataset.emoji;
        });
    });

    // Color picker
    document.querySelectorAll('.color-opt').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('.color-opt').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
        });
    });

    // Search
    document.getElementById('habitSearch').addEventListener('input', e => {
        renderHabitsList(e.target.value.toLowerCase());
    });

    // Update profile display
    document.getElementById('userName').textContent = displayName;
    document.getElementById('displayNameInput').value = displayName;
    document.getElementById('apiUrlInput').value = API_URL;

    // Journal modal events
    document.getElementById('closeJournal').addEventListener('click', closeJournalModal);
    document.getElementById('confirmJournal').addEventListener('click', saveJournalEntry);
    document.getElementById('deleteJournal').addEventListener('click', deleteJournalEntry);

    // Mood picker
    document.querySelectorAll('.mood-opt').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('.mood-opt').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
        });
    });

    // Close journal modal on overlay click
    document.getElementById('journalModal').addEventListener('click', (e) => {
        if (e.target.id === 'journalModal') closeJournalModal();
    });

    // === Dashboard Notes ===
    // Quick mood picker
    document.querySelectorAll('#quickMoodPicker .quick-mood').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('#quickMoodPicker .quick-mood').forEach(e => e.classList.remove('selected'));
            el.classList.add('selected');
        });
    });

    // Quick note save
    const quickSaveBtn = document.getElementById('quickNoteSave');
    if (quickSaveBtn) {
        quickSaveBtn.addEventListener('click', saveQuickNote);
    }

    // Quick note date display
    const quickDateEl = document.getElementById('quickNoteDate');
    if (quickDateEl) {
        const d = new Date();
        const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
        quickDateEl.textContent = `${dayNames[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    }

    // Load existing quick note (today's note) into the input
    const todayStr = formatDate(new Date());
    const todayEntry = state.journal.find(j => j.date === todayStr);
    if (todayEntry) {
        const qInput = document.getElementById('quickNoteInput');
        if (qInput) qInput.value = todayEntry.content || '';
        if (todayEntry.mood) {
            const moodEl = document.querySelector(`#quickMoodPicker .quick-mood[data-mood="${todayEntry.mood}"]`);
            if (moodEl) moodEl.classList.add('selected');
        }
    }

    // View all notes button
    const viewAllBtn = document.getElementById('viewAllNotes');
    if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => {
            openJournalModal(formatDate(new Date()));
        });
    }

    // Enter to save (Ctrl+Enter)
    const quickInput = document.getElementById('quickNoteInput');
    if (quickInput) {
        quickInput.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                saveQuickNote();
            }
        });
    }
}

function initSettings() {
    document.getElementById('saveApiUrl').addEventListener('click', () => {
        const url = document.getElementById('apiUrlInput').value.trim();
        if (!url) { showToast('Vui lòng nhập URL API!', 'error'); return; }
        API_URL = url;
        localStorage.setItem('habitflow_api_url', url);
        showApiStatus('success', '✅ Đã lưu API URL!');
        showToast('Đã lưu API URL thành công!', 'success');
        document.getElementById('apiBanner').classList.remove('show');
        loadData();
        // Register URL for auto-update across devices
        registerApiUrl(url);
    });

    document.getElementById('testApiBtn').addEventListener('click', testAPI);

    // 📋 Copy Share Link — tạo link vĩnh viễn với Spreadsheet ID
    const copyShareBtn = document.getElementById('copyShareLink');
    if (copyShareBtn) {
        copyShareBtn.addEventListener('click', () => {
            let shareUrl;
            if (SHEET_ID) {
                // Ưu tiên: dùng ?sid= (vĩnh viễn, không hết hạn khi deploy lại)
                shareUrl = window.location.origin + window.location.pathname + '?sid=' + encodeURIComponent(SHEET_ID);
            } else {
                // Fallback: dùng ?api= (hết hạn khi deploy lại GAS)
                const url = document.getElementById('apiUrlInput').value.trim() || API_URL;
                if (!url) {
                    showToast('⚠️ Chưa có API URL để chia sẻ! Hãy lưu API URL trước.', 'error');
                    return;
                }
                shareUrl = window.location.origin + window.location.pathname + '?api=' + encodeURIComponent(url);
            }
            navigator.clipboard.writeText(shareUrl).then(() => {
                showToast('📋 Đã copy link chia sẻ!', 'success');
                const info = document.getElementById('shareLinkInfo');
                if (info) {
                    info.style.display = 'flex';
                    setTimeout(() => info.style.display = 'none', 8000);
                }
            }).catch(() => {
                prompt('Copy link này:', shareUrl);
            });
        });
    }

    document.getElementById('saveProfile').addEventListener('click', () => {
        const name = document.getElementById('displayNameInput').value.trim() || 'Người dùng';
        displayName = name;
        localStorage.setItem('habitflow_name', name);
        document.getElementById('userName').textContent = name;

        // Cập nhật greeting ở Dashboard nếu có
        const greetingVal = document.querySelector('.user-name-val');
        if (greetingVal) greetingVal.textContent = name;

        showToast('Đã lưu hồ sơ!', 'success');
    });
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadData() {
    // 1️⃣ Hiển thị ngay từ cache (không cần chờ API)
    const hasCached = loadCache();
    if (hasCached) {
        renderAll();
    }

    if (!API_URL) {
        document.getElementById('apiBanner').classList.add('show');
        if (!hasCached) { renderCalendar(); renderTodayHabits(); renderHabitsList(); }
        return;
    }

    // 2️⃣ Load từ API ngầm (background refresh) — không block UI
    if (!hasCached) showLoading(true);
    try {
        const data = await apiGet({ action: 'getAll' });
        if (data.success) {
            // ✅ MERGE HABITS: Giữ lại trạng thái 'active' từ local nếu server chưa có
            const serverHabits = data.habits || [];
            state.habits = serverHabits.map(sh => {
                const localH = state.habits.find(lh => lh.id === sh.id);
                // Nếu server có giá trị active (sau khi đã update Code.gs) thì dùng của server
                // Nếu server chưa có (cũ) thì dùng của local
                if (sh.active !== undefined) return sh;
                return { ...sh, active: localH ? localH.active : true };
            });

            // ✅ MERGE COMPLETIONS - normalize dates from API
            const apiCompletions = (data.completions || []).map(c => {
                return { ...c, date: normalizeDateStr(c.date) };
            }).filter(c => c.date && c.date.match(/^\d{4}-\d{2}-\d{2}$/));

            state.completions = mergeCompletions(apiCompletions, state.completions);

            // ✅ MERGE JOURNAL entries từ API (smart merge với timestamp)
            if (data.journal) {
                const apiJournal = (data.journal || []).map(j => ({
                    ...j, date: normalizeDateStr(j.date)
                })).filter(j => j.date);
                const apiJournalMap = new Map(apiJournal.map(j => [j.date, j]));

                // Bước 1: Bắt đầu với dữ liệu API
                const merged = [...apiJournal];

                // Bước 2: Kiểm tra local entries
                state.journal.forEach(localJ => {
                    const apiEntry = apiJournalMap.get(localJ.date);

                    if (!apiEntry) {
                        // Entry chỉ có ở local (chưa sync) → giữ lại
                        if (localJ._local) {
                            merged.push(localJ);
                        }
                    } else if (localJ._local && localJ.updatedAt) {
                        // Entry có ở cả 2: local có _local flag → local mới hơn, ưu tiên local
                        const mIdx = merged.findIndex(m => m.date === localJ.date);
                        if (mIdx >= 0) {
                            merged[mIdx] = localJ; // Giữ bản local mới hơn
                        }
                    }
                });

                state.journal = merged;
            }

            state.stats = data.stats || null;
            saveCache();
            renderAll();

            // 📡 Lưu Spreadsheet ID từ API (cho auto-discovery lần sau)
            if (data.spreadsheetId && data.spreadsheetId !== 'YOUR_SPREADSHEET_ID_HERE') {
                SHEET_ID = data.spreadsheetId;
                localStorage.setItem('habitflow_sheet_id', data.spreadsheetId);
            }

            // Merge focus data from getAll response
            if (typeof FocusXP !== 'undefined' && (data.focusHistory || data.focusXP)) {
                FocusXP.mergeFocusFromAPI(data.focusHistory || [], data.focusXP || null);
            }

            // 🎵 Merge playlist từ API
            if (data.playlist && typeof FocusMusic !== 'undefined') {
                FocusMusic.mergeFromApi(data.playlist);
            }
        }
        else {
            showToast('Lỗi tải dữ liệu: ' + (data.error || 'Không xác định'), 'error');
            if (!hasCached) renderCalendar();
        }
    } catch (err) {
        if (!hasCached) {
            showToast('Không thể kết nối API. Đang dùng dữ liệu offline.', 'error');
            document.getElementById('apiBanner').classList.add('show');
            renderCalendar();
        } else {
            showToast('⚠️ Không thể kết nối API – đang hiển thị dữ liệu đã cache.', 'error');
        }
    } finally {
        showLoading(false);
    }

    // 3️⃣ Retry pending sync items từ lần trước (nếu có)
    if (syncQueue.length > 0 && API_URL) {
        console.log(`📤 Retrying ${syncQueue.length} pending sync items...`);
        processSyncQueue();
    }

    // 4️⃣ Retry pending journal entries
    if (journalSyncQueue.length > 0 && API_URL) {
        processJournalSyncQueue();
    }
}

/**
 * Merge completions từ API với completions đang có trong cache.
 *
 * Quy tắc MỚI (sửa bug mất dữ liệu):
 *  - Lấy TẤT CẢ từ API (dữ liệu đã confirmed trên Sheets).
 *  - Giữ lại item cache nếu nó CHƯA CÓ trên API:
 *    → Có thể là tick offline/chưa kịp sync → PHẢI giữ lại.
 *  - CHỈ loại bỏ local item nếu:
 *    1) syncQueue hoàn toàn rỗng (mọi thứ đã sync xong)
 *    2) VÀ item đó không có trên API (= đã bị xóa trên server)
 *
 * Kết quả: Dữ liệu KHÔNG BAO GIỜ mất khi refresh trang.
 */
function mergeCompletions(fromAPI, fromCache) {
    const apiKeys = new Set(fromAPI.map(c => `${c.habitId}_${c.date}`));

    // Nếu syncQueue còn pending → giữ TẤT CẢ local items chưa có trên API
    // Nếu syncQueue rỗng → server là source of truth, chỉ lấy từ API
    const hasPending = syncQueue.length > 0;

    const localOnly = fromCache.filter(c => {
        const key = `${c.habitId}_${c.date}`;
        if (apiKeys.has(key)) return false; // Đã có trên API → dùng bản API

        if (hasPending) return true; // Còn pending → giữ tất cả local

        // Không có pending → kiểm tra xem item này có ĐÚNG là mới tick không
        // Nếu nó có completedAt gần đây (trong 5 phút) → giữ lại (API chưa kịp cập nhật)
        if (c.completedAt) {
            const tickedAt = new Date(c.completedAt).getTime();
            const fiveMinAgo = Date.now() - 5 * 60 * 1000;
            if (tickedAt > fiveMinAgo) return true;
        }
        return false;
    });

    return [...fromAPI, ...localOnly];
}

async function loadCompletionsForMonth(year, month) {
    if (!API_URL) return;
    try {
        const data = await apiGet({ action: 'getCompletions', year, month });
        if (data.success) {
            const prefix = `${year}-${String(month).padStart(2, '0')}`;
            // Lấy những tháng khác giữ nguyên, tháng mới dùng merge
            const otherMonths = state.completions.filter(c => !c.date.startsWith(prefix));
            const thisMerged = mergeCompletions(data.completions || [],
                state.completions.filter(c => c.date.startsWith(prefix)));
            state.completions = [...otherMonths, ...thisMerged];
            saveCache();
        }
    } catch { /* silent – dùng cache hiện tại */ }
}

function renderAll() {
    calculateLocalStats(); // Tính toán lại stats từ state local
    renderCalendar();
    renderTodayHabits();
    renderHabitsList();
    renderStats();
    updateXP();
    renderDailySummaries(); // Mới: Render tóm tắt 7 ngày
    renderDashboardNotes(); // Render ghi chú trên Dashboard
}

/**
 * 🧠 SMART FILTER: Lấy danh sách habits active CHO MỘT NGÀY CỤ THỂ
 * Chỉ trả về habits đã được tạo trước hoặc đúng ngày đó.
 * Habits tạo SAU ngày đó sẽ KHÔNG được tính.
 */
function getActiveHabitsForDate(dateStr) {
    return state.habits.filter(h => {
        if (h.active === false) return false;
        // Nếu habit có createdAt, chỉ tính từ ngày tạo trở đi
        if (h.createdAt) {
            const created = h.createdAt.includes('T')
                ? h.createdAt.split('T')[0]
                : h.createdAt.substring(0, 10);
            if (dateStr < created) return false; // Ngày này trước khi habit được tạo
        }
        return true;
    });
}

/**
 * Tính toán thống kê từ dữ liệu Local (Real-time)
 * Giúp người dùng thấy kết quả ngay lập tức khi tick thói quen
 */
function calculateLocalStats() {
    const habits = state.habits;
    const completions = state.completions;
    if (habits.length === 0) {
        state.stats = { totalHabits: 0, currentStreak: 0, consistencyScore: 0, last30Days: [], streaks: {} };
        return;
    }

    const today = new Date();
    const last30Days = [];
    let totalPoints = 0;

    // 1. Tính toán 30 ngày gần nhất (dùng smart filter theo ngày)
    for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = formatDate(d);

        // 🧠 Smart: Chỉ tính habits đã tồn tại vào ngày đó
        const habitsForDay = getActiveHabitsForDate(dateStr);
        const activeCount = habitsForDay.length || 1; // tránh chia cho 0

        const doneCount = completions.filter(c => {
            if (c.date !== dateStr) return false;
            return habitsForDay.some(h => h.id === c.habitId);
        }).length;
        const pts = habitsForDay.length > 0 ? Math.round((doneCount / activeCount) * 100) : 0;

        last30Days.push({ date: dateStr, completed: doneCount, total: habitsForDay.length, points: pts });
        totalPoints += pts;
    }

    // 2. Tính Consistency Score (30 ngày)
    const consistencyScore = Math.round(totalPoints / 30);

    // 3. Tính streaks cho từng habit
    const streaks = {};
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);
    const todayStr = formatDate(today);

    habits.forEach(h => {
        let s = 0;
        let curr = new Date(today);

        // Kiểm tra xem hôm nay có làm không
        const isDoneToday = completions.some(c => c.habitId === h.id && c.date === todayStr);
        const isDoneYesterday = completions.some(c => c.habitId === h.id && c.date === yesterdayStr);

        // Nếu không làm cả hôm qua lẫn hôm nay -> streak = 0
        if (!isDoneToday && !isDoneYesterday) {
            streaks[h.id] = 0;
            return;
        }

        // Bắt đầu đếm ngược từ hôm nay hoặc hôm qua
        let checkDate = isDoneToday ? new Date(today) : new Date(yesterday);
        while (true) {
            const dStr = formatDate(checkDate);
            if (completions.some(c => c.habitId === h.id && c.date === dStr)) {
                s++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else {
                break;
            }
        }
        streaks[h.id] = s;
    });

    // 4. Tính Overall Current Streak (Ngày có ít nhất 1 habit xong)
    let currentStreak = 0;
    const hasToday = completions.some(c => c.date === todayStr);
    const hasYesterday = completions.some(c => c.date === yesterdayStr);

    if (hasToday || hasYesterday) {
        let d = hasToday ? new Date(today) : new Date(yesterday);
        while (true) {
            const dStr = formatDate(d);
            if (completions.some(c => c.date === dStr)) {
                currentStreak++;
                d.setDate(d.getDate() - 1);
            } else {
                break;
            }
        }
    }

    state.stats = {
        totalHabits: habits.length,
        currentStreak,
        consistencyScore,
        last30Days,
        streaks
    };
}

// ============================================================
// CALENDAR
// ============================================================
function renderCalendar() {
    const container = document.getElementById('calendarContainer');
    updateCalendarTitle();
    if (state.viewMode === 'monthly') {
        container.innerHTML = renderMonthlyCalendar();
        attachCalendarEvents();
    } else {
        container.innerHTML = renderWeeklyCalendar();
        attachCalendarEvents();
    }
}

function updateCalendarTitle() {
    const d = state.currentDate;
    const months = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
        'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    document.getElementById('calendarTitle').textContent = `${months[d.getMonth()]}, ${d.getFullYear()}`;
}

function renderMonthlyCalendar() {
    const d = state.currentDate;
    const year = d.getFullYear(), month = d.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = formatDate(new Date());

    const dayLabels = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    let html = `<div class="cal-month-head">`;
    dayLabels.forEach(l => html += `<div class="cal-day-label">${l}</div>`);
    html += '</div><div class="cal-month-grid">';

    // Ô trống đầu (ngày tháng trước)
    const prevDaysInMonth = new Date(year, month, 0).getDate();
    for (let i = firstDay - 1; i >= 0; i--) {
        const day = prevDaysInMonth - i;
        const dateStr = formatDateFromParts(year, month - 1, day);
        html += buildCalCell(dateStr, day, true, today);
    }

    // Ngày trong tháng
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = formatDateFromParts(year, month, day);
        html += buildCalCell(dateStr, day, false, today);
    }

    // Ô trống cuối (ngày tháng sau)
    const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    let nextDay = 1;
    for (let i = firstDay + daysInMonth; i < totalCells; i++) {
        const dateStr = formatDateFromParts(year, month + 1, nextDay);
        html += buildCalCell(dateStr, nextDay++, true, today);
    }

    html += '</div>';
    return html;
}

function buildCalCell(dateStr, dayNum, isOther, today) {
    const dayCompletions = state.completions.filter(c => c.date === dateStr);
    const completedIds = dayCompletions.map(c => c.habitId);
    // 🧠 Smart: Chỉ hiện habits đã tồn tại vào ngày đó
    const habitsForDay = getActiveHabitsForDate(dateStr);
    const activeHabits = habitsForDay.filter(h => true).concat(
        state.habits.filter(h => h.active === false && completedIds.includes(h.id))
    );
    const totalActive = habitsForDay.length;
    const doneActive = dayCompletions.filter(c => {
        return habitsForDay.some(h => h.id === c.habitId);
    }).length;
    const pct = totalActive > 0 ? Math.round((doneActive / totalActive) * 100) : 0;

    let ptsClass = '';
    let ptsBg = '';
    if (pct === 100) { ptsClass = 'color:#10b981'; ptsBg = 'background:rgba(16,185,129,.2)'; }
    else if (pct >= 50) { ptsClass = 'color:#f59e0b'; ptsBg = 'background:rgba(245,158,11,.2)'; }
    else if (pct > 0) { ptsClass = 'color:#8b949e'; ptsBg = 'background:rgba(139,148,158,.1)'; }

    const isToday = dateStr === today;
    let cellClass = 'cal-cell' + (isOther ? ' other-month' : '') + (isToday ? ' today' : '');

    let habitsHtml = '';
    (activeHabits.slice(0, 4)).forEach(h => {
        const isDone = completedIds.includes(h.id);
        const isPaused = h.active === false;
        habitsHtml += `<div class="cal-habit-row ${isDone ? 'done' : ''} ${isPaused ? 'paused' : ''}" 
      data-habit="${h.id}" data-date="${dateStr}" 
      style="color:${isPaused ? 'var(--text-dim)' : (h.color || '#6366f1')}">
      <div class="habit-check"></div>
      <span>${h.icon || '⭐'} ${h.name}</span>
    </div>`;
    });
    if (activeHabits.length > 4) {
        habitsHtml += `<div style="font-size:10px;color:var(--text-dim);padding-left:4px">+${activeHabits.length - 4} khác</div>`;
    }

    // Journal indicator
    const journalEntry = state.journal.find(j => j.date === dateStr);
    const journalBtn = `<button class="cal-journal-btn ${journalEntry ? 'has-entry' : ''}" 
        onclick="event.stopPropagation(); openJournalModal('${dateStr}')" title="Ghi chú ngày">
        ${journalEntry ? `<span>${journalEntry.mood || '📝'}</span>` : '<i class="fa-solid fa-pen-to-square"></i>'}
        <span>${journalEntry ? (journalEntry.content || '').substring(0, 15) + (journalEntry.content && journalEntry.content.length > 15 ? '...' : '') : 'Ghi chú'}</span>
    </button>`;

    return `<div class="${cellClass}">
    <div class="cal-date">
      <span>${dayNum}</span>
      ${totalActive > 0 ? `<span class="cal-pts-badge" style="${ptsClass};${ptsBg}">${pct}%</span>` : ''}
    </div>
    <div class="cal-habits-mini">${habitsHtml}</div>
    ${totalActive > 0 ? `<div class="cal-progress-bar"><div class="cal-progress-fill" style="width:${pct}%"></div></div>` : ''}
    ${journalBtn}
  </div>`;
}

function renderWeeklyCalendar() {
    const today = new Date();
    // Tuần chứa currentDate
    const d = new Date(state.currentDate);
    const firstDayOfWeek = new Date(d);
    firstDayOfWeek.setDate(d.getDate() - d.getDay());

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
        const day = new Date(firstDayOfWeek);
        day.setDate(firstDayOfWeek.getDate() + i);
        weekDays.push(day);
    }

    const todayStr = formatDate(today);
    const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    let html = '<div class="cal-week">';

    // Header row
    html += '<div class="cal-week-corner"></div>';
    weekDays.forEach((day, i) => {
        const isToday = formatDate(day) === todayStr;
        html += `<div class="cal-week-day ${isToday ? 'today-col' : ''}">
      <div class="wday">${dayNames[i]}</div>
      <div class="wdate">${day.getDate()}</div>
    </div>`;
    });

    // Habit rows
    state.habits.filter(h => h.active !== false).forEach(h => {
        html += `<div class="cal-habit-label">
      <div class="habit-dot" style="background:${h.color}"></div>
      ${h.icon} ${h.name}
    </div>`;
        weekDays.forEach(day => {
            const dateStr = formatDate(day);
            const isDone = state.completions.some(c => c.habitId === h.id && c.date === dateStr);
            html += `<div class="cal-week-cell ${isDone ? 'done' : ''}" data-habit="${h.id}" data-date="${dateStr}">
        <div class="cal-week-check" style="${isDone ? `background:${h.color}; border-color:${h.color}` : ''}">
          ${isDone ? '✓' : ''}
        </div>
      </div>`;
        });
    });

    html += '</div>';
    return html;
}

function attachCalendarEvents() {
    // Monthly: click habit row
    document.querySelectorAll('.cal-habit-row').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const habitId = el.dataset.habit;
            const date = el.dataset.date;
            await toggleCompletion(habitId, date);
        });
    });

    // Weekly: click cell
    document.querySelectorAll('.cal-week-cell').forEach(el => {
        el.addEventListener('click', async () => {
            const habitId = el.dataset.habit;
            const date = el.dataset.date;
            await toggleCompletion(habitId, date);
        });
    });
}

// ============================================================
// TODAY PANEL
// ============================================================
function renderTodayHabits() {
    const container = document.getElementById('todayHabits');
    const today = formatDate(new Date());
    const todayComp = state.completions.filter(c => c.date === today).map(c => c.habitId);

    if (state.habits.length === 0) {
        container.innerHTML = '<div class="empty-state-sm">Chưa có thói quen nào. Thêm thói quen mới nhé!</div>';
        document.getElementById('todayProgress').textContent = '0/0';
        return;
    }

    // 🧠 Smart: Chỉ hiện habits đã tồn tại vào hôm nay
    const activeHabits = getActiveHabitsForDate(today);
    const completedActiveCount = todayComp.filter(id => {
        return activeHabits.some(h => h.id === id);
    }).length;

    const totalCount = activeHabits.length;
    document.getElementById('todayProgress').textContent = `${completedActiveCount}/${totalCount}`;

    // 🎯 Cập nhật Dash Summary
    const pct = totalCount > 0 ? Math.round((completedActiveCount / totalCount) * 100) : 0;
    const dashPct = document.getElementById('dashTodayPct');
    if (dashPct) dashPct.textContent = `${pct}%`;

    // 🎯 Vẽ biểu đồ tròn % (Goal Circle)
    renderGoalCircle(completedActiveCount, totalCount);

    container.innerHTML = activeHabits.map(h => {
        const isDone = todayComp.includes(h.id);
        return `
            <div class="today-habit-item ${isDone ? 'done' : ''}" data-habit="${h.id}" data-date="${today}">
                <div class="today-habit-main">
                    <span class="today-habit-icon">${h.icon || '⭐'}</span>
                    <span class="today-habit-name">${h.name}</span>
                </div>
                <div class="today-check"></div>
            </div>`;
    }).join('');

    container.querySelectorAll('.today-habit-item').forEach(el => {
        el.addEventListener('click', async () => {
            await toggleCompletion(el.dataset.habit, el.dataset.date);
        });
    });
}

// ============================================================
// DASHBOARD DAILY SUMMARIES – TUẦN HIỆN TẠI
// Hiện 7 ngày (T2→CN). Hôm nay phóng to, bên trái cùng.
// ============================================================
function renderDailySummaries() {
    const container = document.getElementById('dailySummariesContainer');
    if (!container) return;

    const now = new Date();
    const todayStr = formatDate(now);

    // Tính Thứ 2 đầu tuần
    const dow = now.getDay(); // 0=CN, 1=T2 … 6=T7
    const diffToMon = dow === 0 ? 6 : dow - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMon);

    // Tạo 7 ngày T2 → CN theo thứ tự
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        weekDays.push(d);
    }

    const dayLabels = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    // ── Render TODAY (glow ring lớn) ──
    const todayData = (() => {
        const dateStr = todayStr;
        const dayCompletions = state.completions.filter(c => c.date === dateStr);
        // 🧠 Smart: Chỉ tính habits đã tồn tại vào hôm nay
        const todayHabits = getActiveHabitsForDate(dateStr);
        const total = todayHabits.length;
        const done = dayCompletions.filter(c => todayHabits.some(h => h.id === c.habitId)).length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const points = done * 10;
        const totalPoints = total * 10;

        const R = 52;
        const circSize = 120;
        const circCenter = circSize / 2;
        const circ = 2 * Math.PI * R;
        const circOffset = circ - (pct / 100) * circ;

        // 🌈 Dynamic color based on completion percentage
        let glowColor, glowBgColor, textShadowColor;
        if (pct === 0) {
            glowColor = '#ef4444';      // Red - chưa bắt đầu
            glowBgColor = 'rgba(239, 68, 68, 0.12)';
            textShadowColor = 'rgba(239, 68, 68, 0.6)';
        } else if (pct <= 33) {
            glowColor = '#f97316';      // Orange - mới bắt đầu
            glowBgColor = 'rgba(249, 115, 22, 0.12)';
            textShadowColor = 'rgba(249, 115, 22, 0.6)';
        } else if (pct <= 66) {
            glowColor = '#eab308';      // Amber/Yellow - đang tiến bộ
            glowBgColor = 'rgba(234, 179, 8, 0.12)';
            textShadowColor = 'rgba(234, 179, 8, 0.6)';
        } else if (pct < 100) {
            glowColor = '#3b82f6';      // Blue - gần hoàn thành
            glowBgColor = 'rgba(59, 130, 246, 0.12)';
            textShadowColor = 'rgba(59, 130, 246, 0.6)';
        } else {
            glowColor = '#10b981';      // Green - hoàn thành 100%
            glowBgColor = 'rgba(16, 185, 129, 0.15)';
            textShadowColor = 'rgba(16, 185, 129, 0.7)';
        }

        return `
            <div class="daily-today-hero">
                <div class="today-glow-ring" style="--glow-color: ${glowColor}; --glow-bg: ${glowBgColor}">
                    <svg width="100%" height="100%" viewBox="0 0 ${circSize} ${circSize}">
                        <defs>
                            <filter id="glowFilter" x="-50%" y="-50%" width="200%" height="200%">
                                <feGaussianBlur stdDeviation="4" result="blur"/>
                                <feComposite in="SourceGraphic" in2="blur" operator="over"/>
                            </filter>
                        </defs>
                        <circle class="glow-bg" cx="${circCenter}" cy="${circCenter}" r="${R}" style="stroke: ${glowBgColor}"></circle>
                        <circle class="glow-fill" cx="${circCenter}" cy="${circCenter}" r="${R}" 
                            filter="url(#glowFilter)"
                            style="stroke-dasharray: ${circ}; stroke-dashoffset: ${circOffset}; stroke: ${glowColor}"></circle>
                    </svg>
                    <div class="glow-center-text">
                        <span class="glow-pct" style="text-shadow: 0 0 20px ${textShadowColor}; color: ${pct === 100 ? glowColor : '#fff'}">${pct}%</span>
                    </div>
                </div>
                <div class="today-hero-info">
                    <span class="today-hero-label" style="color: ${glowColor}">${pct === 100 ? '✅ COMPLETE' : 'TODAY'}</span>
                    <span class="today-hero-points">${points}/${totalPoints} <small>pts</small></span>
                </div>
            </div>
        `;
    })();

    // ── Render 6 ngày còn lại (chỉ vòng tròn nhỏ) ──
    const otherDays = weekDays
        .filter(d => formatDate(d) !== todayStr)
        .map(date => {
            const dateStr = formatDate(date);
            const isFuture = date > now;
            const isPast = date < new Date(now.getFullYear(), now.getMonth(), now.getDate());

            const dayName = dayLabels[date.getDay()];
            const dayNum = date.getDate();

            const dayCompletions = state.completions.filter(c => c.date === dateStr);
            // 🧠 Smart: Chỉ tính habits đã tồn tại vào ngày đó
            const dayHabits = getActiveHabitsForDate(dateStr);
            const total = dayHabits.length;
            const done = dayCompletions.filter(c => dayHabits.some(h => h.id === c.habitId)).length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;

            // Màu sắc
            let circleStroke, timeClass;
            if (isFuture) {
                circleStroke = pct > 0 ? '#06b6d4' : 'var(--border)';
                timeClass = 'future';
            } else {
                circleStroke = pct === 100 ? 'var(--green)' : (pct > 0 ? 'var(--amber)' : 'var(--border)');
                timeClass = 'past';
            }

            const r = 22;
            const size = 52;
            const center = size / 2;
            const circumference = 2 * Math.PI * r;
            const offset = isFuture ? circumference : circumference - (pct / 100) * circumference;

            return `
                <div class="daily-circle-item ${isFuture ? 'future' : ''} time-${timeClass}">
                    <div class="daily-circle-ring">
                        <svg width="${size}" height="${size}">
                            <circle class="bg" cx="${center}" cy="${center}" r="${r}"></circle>
                            <circle class="fill" cx="${center}" cy="${center}" r="${r}" 
                                style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset}; stroke: ${circleStroke}"></circle>
                        </svg>
                        <span class="daily-circle-pct">${isFuture ? '—' : pct + '%'}</span>
                    </div>
                    <span class="daily-circle-day">${dayName}</span>
                    <span class="daily-circle-date">${dayNum}</span>
                </div>
            `;
        }).join('');

    container.innerHTML = `
        <div class="daily-circles-row">${otherDays}</div>
        ${todayData}
    `;
}

function renderGoalCircle(done, total) {
    const canvas = document.getElementById('goalCircle');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const pct = total > 0 ? (done / total) : 0;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = (canvas.width / 2) - 5;

    // Background circle
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Progress arc
    if (pct > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, -Math.PI / 2, (-Math.PI / 2) + (2 * Math.PI * pct));
        ctx.strokeStyle = '#6366f1';
        ctx.lineCap = 'round';
        ctx.lineWidth = 6;
        ctx.stroke();
    }

    // Text %
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(pct * 100) + '%', centerX, centerY);
}

function renderHabitConsistency() {
    // 1. Render for Stats Page
    const statsContainer = document.getElementById('habitConsistencyList');
    const dashContainer = document.getElementById('dashConsistencyList');

    const active = state.habits.filter(h => h.active !== false);

    if (statsContainer) {
        if (active.length === 0) {
            statsContainer.innerHTML = '<div class="empty-state-sm">Không có thói quen đang hoạt động</div>';
        } else {
            statsContainer.innerHTML = active.map(h => {
                const doneCount = state.completions.filter(c => c.habitId === h.id).length;
                const pct = Math.min(100, (doneCount / 30) * 100);
                return `
                    <div class="consistency-item">
                        <div class="consistency-top">
                            <div class="consistency-info">
                                <span class="consistency-icon" style="background:${h.color}15">${h.icon}</span>
                                <span class="consistency-name">${h.name}</span>
                            </div>
                            <span class="consistency-label">${doneCount}/30 Days</span>
                        </div>
                        <div class="consistency-bar-bg">
                            <div class="consistency-bar-fill" style="width:${pct}%; background:${h.color}"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 2. Render for Dashboard (New Design)
    if (dashContainer) {
        if (active.length === 0) {
            dashContainer.innerHTML = '<div class="empty-state-sm">Bắt đầu thói quen ngay!</div>';
        } else {
            dashContainer.innerHTML = active.map(h => {
                const doneCount = state.completions.filter(c => c.habitId === h.id).length;
                const pct = Math.min(100, (doneCount / 30) * 100);
                return `
                    <div class="consistency-dash-item">
                        <div class="consistency-dash-top">
                            <div class="consistency-dash-info">
                                <span class="consistency-dash-icon" style="background:${h.color}15">${h.icon}</span>
                                <span class="consistency-dash-name">${h.name}</span>
                            </div>
                            <span class="consistency-dash-label">${doneCount}/30 Days</span>
                        </div>
                        <div class="consistency-dash-bar-bg">
                            <div class="consistency-dash-bar-fill" style="width:${pct}%; background:${h.color}"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

// ============================================================
// HABITS LIST PAGE
// ============================================================
function renderHabitsList(filter = '') {
    const container = document.getElementById('habitsList');
    const filtered = state.habits.filter(h =>
        h.name.toLowerCase().includes(filter)
    );

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state-sm" style="padding:40px 0">
      ${filter ? '🔍 Không tìm thấy thói quen phù hợp' : '✨ Chưa có thói quen nào. Hãy thêm thói quen mới!'}
    </div>`;
        return;
    }

    container.innerHTML = filtered.map(h => {
        const streak = state.stats?.streaks?.[h.id] || 0;
        const allDone = state.completions.filter(c => c.habitId === h.id).length;
        const isActive = h.active !== false;

        return `<div class="habit-card ${!isActive ? 'inactive' : ''}" data-habit-id="${h.id}">
      <div class="habit-card-icon" style="border-color:${h.color}30">${h.icon || '⭐'}</div>
      <div class="habit-card-info">
        <div class="habit-card-name" style="color:${isActive ? h.color : 'var(--text-dim)'}">${h.name} ${!isActive ? '<span class="status-badge">Đã tắt</span>' : ''}</div>
        <div class="habit-card-meta">📊 ${allDone} lần hoàn thành</div>
      </div>
      <div class="habit-card-streak">
        <div class="streak-num">🔥 ${streak}</div>
        <div class="streak-lbl">NGÀY LIÊN TIẾP</div>
      </div>
      <div class="habit-card-actions">
        <button class="toggle-status-btn ${isActive ? 'active' : ''}" title="${isActive ? 'Tạm dừng' : 'Kích hoạt'}" onclick="toggleHabitStatus('${h.id}')">
          <i class="fa-solid ${isActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
        </button>
        <button class="btn-icon" title="Chỉnh sửa" onclick="editHabit('${h.id}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="btn-icon danger" title="Xoá" onclick="confirmDeleteHabit('${h.id}')">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>`;
    }).join('');
}

async function toggleHabitStatus(habitId) {
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    habit.active = habit.active === false ? true : false;
    saveCache();
    renderAll();

    if (API_URL) {
        try {
            await apiPost({ action: 'updateHabit', habitId: habit.id, active: habit.active });
        } catch {
            showToast('⚠️ Đồng bộ trạng thái lỗi – sẽ thử lại sau.', 'error');
        }
    }
}

// ============================================================
// STATS PAGE
// ============================================================
function renderStats() {
    if (!state.stats) return;
    const s = state.stats;

    const statTotalHabits = document.getElementById('statTotalHabits');
    const statStreak = document.getElementById('statStreak');
    const statScore = document.getElementById('statScore');
    const statTotalDone = document.getElementById('statTotalDone');

    if (statTotalHabits) statTotalHabits.textContent = s.totalHabits || 0;
    if (statStreak) statStreak.textContent = (s.currentStreak || 0) + ' ngày';
    if (statScore) statScore.textContent = (s.consistencyScore || 0) + '%';

    if (statTotalDone) {
        const totalDone = (s.last30Days || []).reduce((sum, d) => sum + d.completed, 0);
        statTotalDone.textContent = totalDone;
    }

    // Streaks list
    const list = document.getElementById('streaksList');
    const maxStreak = Math.max(1, ...Object.values(s.streaks || {}));
    list.innerHTML = state.habits.map(h => {
        const st = s.streaks?.[h.id] || 0;
        const pct = Math.round((st / maxStreak) * 100);
        return `<div class="streak-item">
      <span class="streak-icon">${h.icon || '⭐'}</span>
      <span class="streak-name">${h.name}</span>
      <div class="streak-bar-wrap">
        <div class="streak-bar-fill" style="width:${pct}%; background:${h.color}"></div>
      </div>
      <span class="streak-val">🔥 ${st}</span>
    </div>`;
    }).join('') || '<div class="empty-state-sm">Chưa có dữ liệu</div>';

    renderStatsChart(s.last30Days || []);
    renderHabitConsistency(); // Render danh sách bền bỉ (bây giờ ở trang Thống kê)

    // Dashboard milestones
    const dashStreak = document.getElementById('dashCurrentStreak');
    if (dashStreak) dashStreak.textContent = `${s.currentStreak || 0} Ngày`;

    // Milestones (old element if kept)
    const curStreakEl = document.getElementById('currentStreak');
    if (curStreakEl) curStreakEl.innerHTML = `🔥 ${s.currentStreak || 0} Ngày`;

    const consisScoreEl = document.getElementById('consistencyScore');
    if (consisScoreEl) consisScoreEl.innerHTML = `📈 ${s.consistencyScore || 0}%`;

    // Badges section (Stats Page)
    renderBadges();
}

function renderBadges() {
    const container = document.getElementById('badgesContainer');
    if (!container) return;

    container.innerHTML = BADGES.map(b => {
        const isUnlocked = state.unlockedBadges.includes(b.id);
        return `
            <div class="badge-item ${isUnlocked ? 'unlocked' : 'locked'}">
                <div class="badge-icon">${isUnlocked ? b.icon : '🔒'}</div>
                <div class="badge-info">
                    <div class="badge-name">${b.name}</div>
                    <div class="badge-desc">${b.desc}</div>
                </div>
            </div>
        `;
    }).join('');
}

let statsChartInst = null;
function renderStatsChart(data) {
    const ctx = document.getElementById('statsChart');
    if (!ctx) return;
    if (statsChartInst) statsChartInst.destroy();

    // Style matching the user's image (Teal line area chart)
    statsChartInst = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => {
                const date = new Date(d.date);
                return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' });
            }),
            datasets: [{
                label: 'Hoàn thành (%)',
                data: data.map(d => d.points),
                borderColor: '#10b981', // Teal color from image
                backgroundColor: 'rgba(16, 185, 129, 0.15)', // Light teal fill
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: '#10b981',
                pointBorderColor: '#fff',
                pointBorderWidth: 1,
                pointRadius: 4,
                pointHoverRadius: 6,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: ctx => `${ctx.raw}%` }
                }
            },
            scales: {
                y: {
                    min: 0, max: 100,
                    grid: { color: 'rgba(48, 54, 61, 0.4)' },
                    ticks: {
                        color: '#8b949e',
                        font: { size: 10 },
                        callback: v => v + '%'
                    }
                },
                x: {
                    grid: { color: 'rgba(48, 54, 61, 0.2)' },
                    ticks: {
                        color: '#8b949e',
                        font: { size: 10 }, // Trả về cỡ chữ bình thường cho full-width
                        maxRotation: 0,
                        minRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 15
                    }
                }
            }
        }
    });
}



function updateXP() {
    const totalDone = state.completions.length;
    const xp = totalDone * 10;

    let level = 1;
    let tempXp = xp;
    while (tempXp >= level * 100) {
        tempXp -= level * 100;
        level++;
    }

    const xpNeeded = level * 100;
    const progress = Math.min(100, (tempXp / xpNeeded) * 100);

    // Reset badges nếu không còn completion nào
    if (totalDone === 0 && state.unlockedBadges.length > 0) {
        state.unlockedBadges = [];
        localStorage.setItem('habitflow_badges', JSON.stringify([]));
    }

    // Sidebar & Sidebar stats
    const userXPEl = document.getElementById('userXP');
    const xpBarEl = document.getElementById('xpBar');
    if (userXPEl) userXPEl.textContent = `${xp} XP · Level ${level}`;
    if (xpBarEl) xpBarEl.style.width = progress + '%';

    // Dashboard Info
    const dashLevel = document.getElementById('dashLevel');
    if (dashLevel) dashLevel.textContent = `Cấp ${level}`;

    // Update Premium Rank Card
    updateRankCard(level, tempXp, xpNeeded, progress);

    // Check badges
    checkBadges(totalDone, level);
}

function updateRankCard(level, currentXP, nextXP, progress) {
    const rankNameEl = document.getElementById('rankName');
    const rankLevelEl = document.getElementById('rankLevel');
    const rankXPTextEl = document.getElementById('rankXPText');
    const rankProgressBarEl = document.getElementById('rankProgressBar');
    const nextMilestoneEl = document.getElementById('nextMilestone');

    if (!rankNameEl) return;

    // Rank Logic
    let rank = 'Novice Habit-builder';
    if (level > 20) rank = 'Unstoppable Force';
    else if (level > 15) rank = 'Master of Will';
    else if (level > 10) rank = 'Elite Performer';
    else if (level > 5) rank = 'Disciplined Learner';

    rankNameEl.textContent = rank;
    rankLevelEl.textContent = `Level ${level}`;
    rankXPTextEl.textContent = `${currentXP.toLocaleString()} / ${nextXP.toLocaleString()} XP`;
    rankProgressBarEl.style.width = progress + '%';

    // Milestone Logic
    let nextMilestone = 'Level ' + (level + 1);
    // Suggest unobtained badges
    const unobtained = BADGES.filter(b => !state.unlockedBadges.includes(b.id));
    if (unobtained.length > 0) {
        nextMilestone = `"${unobtained[0].name}" Badge`;
    }

    nextMilestoneEl.textContent = nextMilestone;
}

function checkBadges(totalDone, level) {
    const newlyUnlocked = [];
    const stats = state.stats;

    BADGES.forEach(b => {
        if (state.unlockedBadges.includes(b.id)) return;

        let unlocked = false;
        if (b.id === 'first_step' && totalDone >= 1) unlocked = true;
        if (b.id === 'streak_7' && (stats?.currentStreak || 0) >= 7) unlocked = true;
        if (b.id === 'consistency_pro' && (stats?.consistencyScore || 0) >= 90) unlocked = true;
        if (b.id === 'habit_master' && totalDone >= 100) unlocked = true;
        if (b.id === 'multi_tasker' && state.habits.length >= 5) unlocked = true;

        if (unlocked) {
            state.unlockedBadges.push(b.id);
            newlyUnlocked.push(b);
        }
    });

    if (newlyUnlocked.length > 0) {
        localStorage.setItem('habitflow_badges', JSON.stringify(state.unlockedBadges));
        newlyUnlocked.forEach(b => {
            showToast(`🏆 Mở khóa danh hiệu: ${b.name} ${b.icon}`, 'success');
        });
        if (state.currentPage === 'stats') renderStats(); // Refresh stats page if open
    }
}

// ============================================================
// TOGGLE COMPLETION
// ✅ Tick → lưu cache ngay lập tức → sync API ngầm
// ❌ Không bao giờ revert UI dù API lỗi
// ============================================================
function toggleCompletion(habitId, date) {
    // 1️⃣ Cập nhật state ngay lập tức
    const existingIdx = state.completions.findIndex(
        c => c.habitId === habitId && c.date === date
    );
    const isNowDone = existingIdx < 0; // true = vừa tick, false = vừa bỏ tick

    if (existingIdx >= 0) {
        state.completions.splice(existingIdx, 1);
    } else {
        state.completions.push({ habitId, date, completedAt: new Date().toISOString() });
    }

    // 2️⃣ Lưu cache ngay – giữ nguyên dù reload trang
    saveCache();

    // 3️⃣ Cập nhật UI ngay
    calculateLocalStats(); // Tính stats mới ngay
    renderCalendar();
    renderTodayHabits();
    renderStats(); // Update dashboard & stats page
    updateXP();
    renderDailySummaries(); // Update Daily Summaries (points)

    // 4️⃣ Hiện toast tức thì (không chờ API)
    showToast(isNowDone ? '✅ Đã hoàn thành! Đang lưu...' : '↩️ Đã bỏ đánh dấu', 'success');

    if (!API_URL) {
        // Không có API: vẫn lưu cache, chỉ cảnh báo
        showToast('💾 Lưu offline – kết nối API để đồng bộ lên Sheets', 'error');
        return;
    }

    // 5️⃣ Đẩy vào queue để sync lên Google Sheets ngầm
    enqueuSync(habitId, date);
}

// ============================================================
// HABIT MODAL
// ============================================================
function openHabitModal(habit = null) {
    state.editingHabitId = habit?.id || null;
    document.getElementById('modalTitle').textContent = habit ? 'Chỉnh sửa thói quen' : 'Thêm thói quen mới';
    document.getElementById('habitName').value = habit?.name || '';
    document.getElementById('habitIcon').value = habit?.icon || '';

    // emoji
    document.querySelectorAll('.emoji-opt').forEach(e => {
        e.classList.toggle('selected', e.dataset.emoji === (habit?.icon || '⭐'));
    });
    // color
    document.querySelectorAll('.color-opt').forEach(e => {
        e.classList.toggle('selected', e.dataset.color === (habit?.color || '#6366f1'));
    });

    document.getElementById('habitModal').classList.add('show');
}

function closeModal() {
    document.getElementById('habitModal').classList.remove('show');
    state.editingHabitId = null;
}

async function saveHabit() {
    const name = document.getElementById('habitName').value.trim();
    if (!name) { showToast('Vui lòng nhập tên thói quen!', 'error'); return; }

    const iconInput = document.getElementById('habitIcon').value.trim();
    const selectedEmoji = document.querySelector('.emoji-opt.selected')?.dataset.emoji || '⭐';
    const icon = iconInput || selectedEmoji;
    const color = document.querySelector('.color-opt.selected')?.dataset.color || '#6366f1';

    closeModal();
    showLoading(true);

    try {
        if (state.editingHabitId) {
            const idx = state.habits.findIndex(h => h.id === state.editingHabitId);
            if (idx >= 0) {
                state.habits[idx].name = name;
                state.habits[idx].icon = icon;
                state.habits[idx].color = color;
            }
            if (API_URL) {
                const habit = state.habits[idx];
                const result = await apiPost({
                    action: 'updateHabit',
                    habitId: state.editingHabitId,
                    name,
                    icon,
                    color,
                    active: habit.active !== false
                });
                if (result.success) {
                    showToast('✅ Đã cập nhật thói quen!', 'success');
                } else {
                    throw new Error(result.error || 'Lỗi không xác định khi cập nhật');
                }
            } else {
                showToast('✅ Đã cập nhật thói quen!', 'success');
            }
        } else {
            const newHabit = { name, icon, color, active: true, createdAt: new Date().toISOString() };
            if (!API_URL) {
                newHabit.id = 'local_' + Date.now();
                state.habits.push(newHabit);
                showToast('✅ Đã thêm thói quen mới!', 'success');
            } else {
                const result = await apiPost({ action: 'addHabit', ...newHabit });
                if (result.success) {
                    state.habits.push(result.habit);
                    showToast('✅ Đã thêm thói quen mới!', 'success');
                } else {
                    throw new Error(result.error || 'Lỗi không xác định khi thêm mới');
                }
            }
        }
        saveCache(); // lưu habits mới vào cache
        renderAll();
    } catch (err) {
        showToast('Lỗi: ' + err.message, 'error');
    } finally {
        showLoading(false);
    }
}

function editHabit(habitId) {
    const habit = state.habits.find(h => h.id === habitId);
    if (habit) openHabitModal(habit);
}

function closeConfirmModal() {
    document.getElementById('confirmModal').classList.remove('show');
}

function showConfirmModal({ title, message, onConfirm, confirmText, isDanger }) {
    document.getElementById('confirmTitle').textContent = title || 'Xác nhận';
    document.getElementById('confirmMessage').textContent = message || 'Bạn có chắc chắn?';

    const confirmBtn = document.getElementById('btnConfirmAction');
    confirmBtn.innerHTML = `<i class="fa-solid fa-${isDanger ? 'trash' : 'check'}"></i> ${confirmText || 'Đồng ý'}`;
    confirmBtn.className = `btn-confirm ${isDanger ? 'danger' : ''}`;

    // Xoá listeners cũ bằng cách clone node
    const newBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

    newBtn.addEventListener('click', () => {
        onConfirm();
        closeConfirmModal();
    });

    document.getElementById('confirmModal').classList.add('show');
}

async function confirmDeleteHabit(habitId) {
    const habit = state.habits.find(h => h.id === habitId);
    const name = habit ? habit.name : 'thói quen này';

    showConfirmModal({
        title: 'Xoá thói quen',
        message: `Bạn có chắc muốn xoá "${name}" không?\nDữ liệu lịch sử liên quan sẽ bị xoá vĩnh viễn.`,
        confirmText: 'Đồng ý xoá',
        isDanger: true,
        onConfirm: async () => {
            // Xoá ngay lập tức trên UI
            state.habits = state.habits.filter(h => h.id !== habitId);
            state.completions = state.completions.filter(c => c.habitId !== habitId);
            saveCache();
            showToast('🗑️ Đã xoá thói quen!', 'success');
            renderAll();

            if (API_URL) {
                showLoading(true);
                try {
                    await apiPost({ action: 'deleteHabit', habitId });
                } catch {
                    showToast('⚠️ Xoá offline – chưa đồng bộ lên Sheets.', 'error');
                } finally {
                    showLoading(false);
                }
            }
        }
    });
}

// ============================================================
// 📝 DASHBOARD NOTES
// ============================================================
function renderDashboardNotes() {
    const container = document.getElementById('dashboardNotesList');
    if (!container) return;

    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const moodLabels = {
        '😊': 'Vui vẻ', '😌': 'Bình yên', '😐': 'Bình thường',
        '😔': 'Buồn', '😤': 'Khó chịu', '🤩': 'Hưng phấn',
        '😴': 'Mệt mỏi', '🥰': 'Hạnh phúc'
    };

    // Sort by date descending, take recent 5
    const recentNotes = [...state.journal]
        .filter(j => j.content || j.mood) // Only show entries with content or mood
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5);

    if (recentNotes.length === 0) {
        container.innerHTML = `
            <div class="notes-empty">
                <i class="fa-regular fa-note-sticky"></i>
                Chưa có ghi chú nào. Hãy viết ghi chú đầu tiên ở trên!
            </div>
        `;
        return;
    }

    const todayStr = formatDate(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayStr = formatDate(yesterdayDate);

    container.innerHTML = recentNotes.map(note => {
        const d = new Date(note.date + 'T00:00:00');
        let dateLabel;
        if (note.date === todayStr) {
            dateLabel = 'Hôm nay';
        } else if (note.date === yesterdayStr) {
            dateLabel = 'Hôm qua';
        } else {
            dateLabel = `${dayNames[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}`;
        }

        const moodIcon = note.mood || '📝';
        const moodName = moodLabels[note.mood] || '';
        const hasContent = note.content && note.content.trim();

        return `
            <div class="note-card" data-date="${note.date}" onclick="openJournalModal('${note.date}')">
                <div class="note-mood-icon">${moodIcon}</div>
                <div class="note-content">
                    <div class="note-meta">
                        <span class="note-date-label">${dateLabel}</span>
                        ${moodName ? `<span class="note-mood-badge">${moodName}</span>` : ''}
                    </div>
                    <div class="note-text ${!hasContent ? 'empty-text' : ''}">
                        ${hasContent ? note.content : 'Không có ghi chú'}
                    </div>
                </div>
                <div class="note-actions">
                    <button class="note-action-btn" title="Sửa" onclick="event.stopPropagation(); openJournalModal('${note.date}')">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="note-action-btn danger" title="Xóa" onclick="event.stopPropagation(); deleteDashboardNote('${note.date}')">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    // Show "more" link if there are more than 5 entries
    const totalNotes = state.journal.filter(j => j.content || j.mood).length;
    if (totalNotes > 5) {
        container.innerHTML += `
            <div class="notes-more-link" onclick="openJournalModal(formatDate(new Date()))">
                <i class="fa-solid fa-book-open"></i> Xem tất cả ${totalNotes} ghi chú
            </div>
        `;
    }
}

async function saveQuickNote() {
    const mood = document.querySelector('#quickMoodPicker .quick-mood.selected')?.dataset.mood || '';
    const content = document.getElementById('quickNoteInput').value.trim();

    if (!mood && !content) {
        showToast('Hãy chọn tâm trạng hoặc viết ghi chú!', 'error');
        return;
    }

    const todayStr = formatDate(new Date());
    const entry = {
        date: todayStr,
        mood,
        content,
        updatedAt: new Date().toISOString(),
        _local: true,
    };

    // Update local state
    const existingIdx = state.journal.findIndex(j => j.date === todayStr);
    if (existingIdx >= 0) {
        state.journal[existingIdx] = entry;
    } else {
        state.journal.push(entry);
    }

    saveCache();
    renderDashboardNotes();
    renderCalendar();
    showToast(`${mood || '📝'} Đã lưu ghi chú hôm nay!`, 'success');

    // Animate save button
    const btn = document.getElementById('quickNoteSave');
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.style.background = 'linear-gradient(135deg, #10b981, #34d399)';
        setTimeout(() => {
            btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
            btn.style.background = '';
        }, 1500);
    }

    // Sync to API
    if (API_URL) {
        try {
            await apiPost({
                action: 'saveJournal',
                date: todayStr,
                mood,
                content
            });
            const idx = state.journal.findIndex(j => j.date === entry.date);
            if (idx >= 0) delete state.journal[idx]._local;
            saveCache();
        } catch {
            // 🔄 Thêm vào queue để retry lần sau
            enqueueJournalSync(todayStr, mood, content);
            showToast('⚠️ Ghi chú lưu offline – sẽ đồng bộ sau.', 'error');
        }
    }
}

async function deleteDashboardNote(dateStr) {
    const idx = state.journal.findIndex(j => j.date === dateStr);
    if (idx >= 0) {
        state.journal.splice(idx, 1);
        saveCache();
        renderDashboardNotes();
        renderCalendar();
        showToast('🗑️ Đã xóa ghi chú.', 'success');
    }

    // If it's today's note, clear the quick input
    const todayStr = formatDate(new Date());
    if (dateStr === todayStr) {
        const qInput = document.getElementById('quickNoteInput');
        if (qInput) qInput.value = '';
        document.querySelectorAll('#quickMoodPicker .quick-mood').forEach(e => e.classList.remove('selected'));
    }

    // Sync to API
    if (API_URL) {
        try {
            await apiPost({
                action: 'saveJournal',
                date: dateStr,
                mood: '',
                content: ''
            });
        } catch { /* silent */ }
    }
}

// ============================================================
// 📝 DAILY JOURNAL
// ============================================================
let currentJournalDate = null;

function openJournalModal(dateStr) {
    currentJournalDate = dateStr;
    const modal = document.getElementById('journalModal');

    // Format date for display
    const d = new Date(dateStr + 'T00:00:00');
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const monthNames = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
        'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    const dateDisplay = `<i class="fa-solid fa-calendar-day"></i> ${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    document.getElementById('journalDateDisplay').innerHTML = dateDisplay;

    // Load existing entry
    const existing = state.journal.find(j => j.date === dateStr);

    // Reset mood picker
    document.querySelectorAll('.mood-opt').forEach(e => e.classList.remove('selected'));

    if (existing) {
        document.getElementById('journalContent').value = existing.content || '';
        // Select the matching mood
        if (existing.mood) {
            const moodEl = document.querySelector(`.mood-opt[data-mood="${existing.mood}"]`);
            if (moodEl) moodEl.classList.add('selected');
        }
        document.getElementById('deleteJournal').style.display = 'inline-flex';
    } else {
        document.getElementById('journalContent').value = '';
        document.getElementById('deleteJournal').style.display = 'none';
    }

    // Show stats for this day
    const dayCompletions = state.completions.filter(c => c.date === dateStr);
    const totalActive = state.habits.filter(h => h.active !== false).length;
    const doneCount = dayCompletions.filter(c => {
        const h = state.habits.find(hab => hab.id === c.habitId);
        return h && h.active !== false;
    }).length;

    const statsHtml = `
        <span class="stat-item"><i class="fa-solid fa-check-circle"></i> ${doneCount}/${totalActive} thói quen</span>
        <span class="stat-item"><i class="fa-solid fa-fire"></i> ${totalActive > 0 ? Math.round((doneCount / totalActive) * 100) : 0}% hoàn thành</span>
    `;
    document.getElementById('journalStats').innerHTML = statsHtml;

    // Show modal
    modal.classList.add('show');

    // Focus textarea with slight delay
    setTimeout(() => document.getElementById('journalContent').focus(), 200);
}

function closeJournalModal() {
    document.getElementById('journalModal').classList.remove('show');
    currentJournalDate = null;
}

async function saveJournalEntry() {
    if (!currentJournalDate) return;

    const mood = document.querySelector('.mood-opt.selected')?.dataset.mood || '';
    const content = document.getElementById('journalContent').value.trim();

    if (!mood && !content) {
        showToast('Hãy chọn tâm trạng hoặc viết ghi chú!', 'error');
        return;
    }

    const entry = {
        date: currentJournalDate,
        mood,
        content,
        updatedAt: new Date().toISOString(),
        _local: true, // Mark as local until synced
    };

    // Update local state
    const existingIdx = state.journal.findIndex(j => j.date === currentJournalDate);
    if (existingIdx >= 0) {
        state.journal[existingIdx] = entry;
    } else {
        state.journal.push(entry);
    }

    saveCache();
    renderCalendar();
    renderDashboardNotes();

    // Sync quick note input if saving today's journal
    const todayCheck = formatDate(new Date());
    if (currentJournalDate === todayCheck) {
        const qInput = document.getElementById('quickNoteInput');
        if (qInput) qInput.value = content;
        document.querySelectorAll('#quickMoodPicker .quick-mood').forEach(e => e.classList.remove('selected'));
        if (mood) {
            const mEl = document.querySelector(`#quickMoodPicker .quick-mood[data-mood="${mood}"]`);
            if (mEl) mEl.classList.add('selected');
        }
    }

    closeJournalModal();
    showToast(`${mood || '📝'} Đã lưu ghi chú!`, 'success');

    // Sync to API
    if (API_URL) {
        try {
            await apiPost({
                action: 'saveJournal',
                date: entry.date,
                mood,
                content
            });
            // Remove _local flag after sync
            const idx = state.journal.findIndex(j => j.date === entry.date);
            if (idx >= 0) delete state.journal[idx]._local;
            saveCache();
        } catch {
            // 🔄 Thêm vào queue để retry lần sau
            enqueueJournalSync(entry.date, mood, content);
            showToast('⚠️ Ghi chú lưu offline – sẽ đồng bộ sau.', 'error');
        }
    }
}

async function deleteJournalEntry() {
    if (!currentJournalDate) return;

    const idx = state.journal.findIndex(j => j.date === currentJournalDate);
    if (idx >= 0) {
        state.journal.splice(idx, 1);
        saveCache();
        renderCalendar();
        renderDashboardNotes();
    }

    closeJournalModal();
    showToast('🗑️ Đã xóa ghi chú.', 'success');

    // Sync to API (save with empty content = effective delete)
    if (API_URL) {
        try {
            await apiPost({
                action: 'saveJournal',
                date: currentJournalDate,
                mood: '',
                content: ''
            });
        } catch { /* silent */ }
    }
}

// ============================================================
// API HELPERS
// ============================================================
async function apiGet(params) {
    const url = new URL(API_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' });
    return res.json();
}

async function apiPost(body) {
    const res = await fetch(API_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body)
    });
    return res.json();
}

async function testAPI() {
    const url = document.getElementById('apiUrlInput').value.trim();
    if (!url) { showToast('Nhập URL trước!', 'error'); return; }
    const btn = document.getElementById('testApiBtn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra...';
    try {
        const res = await fetch(url + '?action=getHabits', { redirect: 'follow' });
        const data = await res.json();
        if (data.success !== undefined) {
            showApiStatus('success', `✅ Kết nối thành công! Tìm thấy ${data.habits?.length || 0} thói quen.`);
        } else {
            showApiStatus('error', '❌ API trả về dữ liệu không hợp lệ');
        }
    } catch (err) {
        showApiStatus('error', '❌ Lỗi kết nối: ' + err.message);
    } finally {
        btn.innerHTML = '<i class="fa-solid fa-vial"></i> Kiểm tra kết nối';
    }
}

function showApiStatus(type, msg) {
    const el = document.getElementById('apiStatus');
    el.className = 'api-status ' + type;
    el.textContent = msg;
    setTimeout(() => el.className = 'api-status', 5000);
}

// ============================================================
// 🔄 AUTO-UPDATE API URL
// Tự động phát hiện và cập nhật API URL mới khi deploy lại.
// URL cũ query Settings sheet → tìm URL mới → chuyển đổi tự động.
// ============================================================
let apiUpdateCheckInterval = null;
const API_UPDATE_CHECK_MS = 5 * 60 * 1000; // Kiểm tra mỗi 5 phút

function initAutoUpdate() {
    // Toggle auto-update
    const toggle = document.getElementById('autoUpdateToggle');
    const isEnabled = localStorage.getItem('habitflow_auto_update') !== 'false';
    if (toggle) {
        toggle.checked = isEnabled;
        toggle.addEventListener('change', () => {
            const on = toggle.checked;
            localStorage.setItem('habitflow_auto_update', on);
            const label = document.getElementById('autoUpdateLabel');
            if (label) label.textContent = on ? 'Bật' : 'Tắt';
            if (on) startApiUpdateCheck();
            else stopApiUpdateCheck();
            showToast(on ? '🔄 Tự động cập nhật đã bật' : '⏸️ Tự động cập nhật đã tắt', 'success');
        });
        const label = document.getElementById('autoUpdateLabel');
        if (label) label.textContent = isEnabled ? 'Bật' : 'Tắt';
    }

    // Manual check button
    const checkBtn = document.getElementById('checkUpdateBtn');
    if (checkBtn) {
        checkBtn.addEventListener('click', async () => {
            checkBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kiểm tra...';
            checkBtn.disabled = true;
            await checkForApiUpdate(true);
            checkBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Kiểm tra cập nhật';
            checkBtn.disabled = false;
        });
    }

    // Show last registered info
    updateAutoUpdateTimestamp();

    // Start periodic check
    if (isEnabled && API_URL) {
        setTimeout(() => checkForApiUpdate(), 3000);
        startApiUpdateCheck();
    }
}

async function checkForApiUpdate(manual = false) {
    if (!API_URL) {
        if (manual) updateAutoUpdateStatus('warning', '⚠️ Chưa có API URL. Hãy nhập URL trước.');
        return;
    }

    const autoUpdate = localStorage.getItem('habitflow_auto_update') !== 'false';
    if (!autoUpdate && !manual) return;

    try {
        const data = await apiGet({ action: 'getLatestUrl' });

        if (data.success && data.url && data.url !== API_URL) {
            console.log(`🔄 New API URL detected: ${data.url}`);

            // Verify new URL works before switching
            let verified = false;
            try {
                const testRes = await fetch(data.url + '?action=getHabits', { redirect: 'follow' });
                const testData = await testRes.json();
                verified = testData.success !== undefined;
            } catch {
                console.log('⚠️ New URL unreachable, skipping update');
            }

            if (!verified) {
                if (manual) updateAutoUpdateStatus('warning', '⚠️ URL mới không thể truy cập. Giữ nguyên URL hiện tại.');
                return;
            }

            // Switch to new URL
            const oldUrl = API_URL;
            API_URL = data.url;
            localStorage.setItem('habitflow_api_url', data.url);

            // Update Settings input
            const apiInput = document.getElementById('apiUrlInput');
            if (apiInput) apiInput.value = data.url;

            const timeStr = new Date().toLocaleTimeString('vi-VN');
            updateAutoUpdateStatus('success', `✅ API URL đã tự động cập nhật lúc ${timeStr}`);
            showToast('🔄 API URL đã được tự động cập nhật!', 'success');
            console.log(`🔄 API URL updated: ${oldUrl} → ${data.url}`);

            // Reload data with new URL
            loadData();
        } else {
            if (manual) {
                updateAutoUpdateStatus('success', '✅ API URL hiện tại đã là mới nhất.');
                setTimeout(() => updateAutoUpdateStatus('', ''), 5000);
            }
        }
    } catch (err) {
        console.log('Auto-update check:', err.message);
        if (manual) {
            updateAutoUpdateStatus('warning', '⚠️ Không thể kiểm tra: ' + err.message);
        }
    }
}

async function registerApiUrl(url) {
    if (!url) return;
    try {
        const res = await fetch(url, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'registerUrl', url: url })
        });
        const data = await res.json();
        if (data.success) {
            console.log('✅ API URL registered to Settings sheet');
            updateAutoUpdateStatus('success', '✅ URL đã được đăng ký. Các thiết bị khác sẽ tự cập nhật.');
            localStorage.setItem('habitflow_url_registered_at', new Date().toISOString());
            updateAutoUpdateTimestamp();
            setTimeout(() => updateAutoUpdateStatus('', ''), 8000);
        }
    } catch (err) {
        console.log('Failed to register URL:', err.message);
    }
}

function startApiUpdateCheck() {
    stopApiUpdateCheck();
    if (API_URL) {
        apiUpdateCheckInterval = setInterval(() => checkForApiUpdate(), API_UPDATE_CHECK_MS);
        console.log('🔄 Auto-update check started (every 5 min)');
    }
}

function stopApiUpdateCheck() {
    if (apiUpdateCheckInterval) {
        clearInterval(apiUpdateCheckInterval);
        apiUpdateCheckInterval = null;
    }
}

function updateAutoUpdateStatus(type, msg) {
    const el = document.getElementById('autoUpdateStatus');
    if (el) {
        el.className = 'auto-update-status ' + type;
        el.innerHTML = msg;
    }
}

function updateAutoUpdateTimestamp() {
    const ts = localStorage.getItem('habitflow_url_registered_at');
    const el = document.getElementById('autoUpdateLastRegistered');
    if (el && ts) {
        const d = new Date(ts);
        el.textContent = `Đăng ký lần cuối: ${d.toLocaleDateString('vi-VN')} lúc ${d.toLocaleTimeString('vi-VN')}`;
    } else if (el) {
        el.textContent = 'Chưa đăng ký URL nào';
    }
}

// ============================================================
// NAVIGATION
// ============================================================
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + name)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.page === name);
    });
    const titles = { dashboard: 'Dashboard', habits: 'Thói quen', stats: 'Thống kê', focus: 'Thời gian tập trung', settings: 'Cài đặt' };
    document.querySelector('#pageTitle h1').textContent = titles[name] || name;
    closeSidebar();
    if (name === 'stats') { renderStats(); }

    // Toggle floating focus menu
    const ffm = document.getElementById('focusFloatMenu');
    if (ffm) {
        ffm.classList.toggle('visible', name === 'focus');
    }
}

function setView(mode) {
    state.viewMode = mode;
    document.getElementById('btnMonthly').classList.toggle('active', mode === 'monthly');
    document.getElementById('btnWeekly').classList.toggle('active', mode === 'weekly');
    renderCalendar();
}

function navigatePeriod(dir) {
    const d = state.currentDate;
    if (state.viewMode === 'monthly') {
        state.currentDate = new Date(d.getFullYear(), d.getMonth() + dir, 1);
        // Tải completions cho tháng mới
        if (API_URL) {
            loadCompletionsForMonth(state.currentDate.getFullYear(), state.currentDate.getMonth() + 1)
                .then(() => renderCalendar());
            return;
        }
    } else {
        state.currentDate = new Date(d);
        state.currentDate.setDate(d.getDate() + dir * 7);
    }
    renderCalendar();
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
}

// ============================================================
// UI HELPERS
// ============================================================
function showLoading(show) {
    document.getElementById('loadingOverlay').classList.toggle('show', show);
}

let toastTimer = null;
function showToast(msg, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.className = 'toast', 3000);
}

// ============================================================
// DATE UTILS
// ============================================================
function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDateFromParts(year, month, day) {
    // month is 0-indexed, handles overflow
    const d = new Date(year, month, day);
    return formatDate(d);
}


function formatDateVi(date) {
    const days = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
    return `${days[date.getDay()]}, ${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

/**
 * Normalize any date string from API to YYYY-MM-DD format.
 * Handles:
 * - Already correct: "2026-03-02" → "2026-03-02"
 * - ISO string: "2026-03-02T00:00:00.000Z" → "2026-03-02"
 * - Truncated from Google Sheets: "Mon Mar 02 2026 00:00:00 GM" → "2026-03-02"
 * - Full toString: "Mon Mar 02 2026 00:00:00 GMT+0700" → "2026-03-02"
 * Uses regex extraction to avoid timezone offset issues with new Date().
 */
function normalizeDateStr(dateStr) {
    if (!dateStr) return '';
    const s = String(dateStr);
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // ISO string with T
    if (s.includes('T')) return s.split('T')[0];
    // Month name format: "Mon Mar 02 2026..." or "Mar 02, 2026"
    const MONTHS = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
    };
    // Pattern: optional "Mon " + "Mar 02 2026" (with or without comma)
    const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1]]) {
        return `${m[3]}-${MONTHS[m[1]]}-${String(m[2]).padStart(2, '0')}`;
    }
    // Last resort: try Date parse but use local date parts to avoid TZ shift
    try {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
            // Use getFullYear/getMonth/getDate (local time) to avoid UTC offset issue
            const y = d.getFullYear();
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const dy = String(d.getDate()).padStart(2, '0');
            return `${y}-${mo}-${dy}`;
        }
    } catch { /* ignore */ }
    return s;
}

// ============================================================
// ⏱️ FOCUS TIMER MODULE
// ============================================================
const FocusTimer = (() => {
    // ── CONFIG ──
    const MODES = {
        deepwork: { label: 'Deep Work Session', duration: 25 * 60, subtitle: 'Stay focused for 25 minutes', points: 50 },
        shortbreak: { label: 'Short Break', duration: 5 * 60, subtitle: 'Take a short 5 minute break', points: 10 },
        longbreak: { label: 'Long Break', duration: 15 * 60, subtitle: 'Relax for 15 minutes', points: 20 },
        custom: { label: 'Custom Session', duration: 45 * 60, subtitle: 'Custom focus session', points: 40 },
    };

    const RARITY_CONFIG = {
        common: { label: 'COMMON', color: '#10b981', weight: 50 },
        uncommon: { label: 'UNCOMMON', color: '#3b82f6', weight: 25 },
        rare: { label: 'RARE', color: '#06b6d4', weight: 15 },
        legendary: { label: 'LEGENDARY', color: '#f59e0b', weight: 10 },
    };

    const WHEEL_COLORS = [
        '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
        '#8b5cf6', '#06b6d4', '#ec4899', '#6366f1',
    ];

    const CIRCUMFERENCE = 2 * Math.PI * 126; // ~791.68

    // ── STATE ──
    let currentMode = 'deepwork';
    let timeLeft = MODES.deepwork.duration;
    let totalTime = MODES.deepwork.duration;
    let timerInterval = null;
    let isRunning = false;
    let sessionsDone = 0;
    const sessionsGoal = 4;
    let spinCharges = 0;
    let isSpinning = false;
    let spinAngle = 0;

    // ── DATA (localStorage) ──
    let editingRewardId = null; // Track which reward is being edited
    let rewardPool = JSON.parse(localStorage.getItem('habitflow_rewards') || 'null') || [
        { id: 'r1', name: '15p chơi game', icon: '🎮', rarity: 'common' },
        { id: 'r2', name: 'Ăn vặt ngon', icon: '🍫', rarity: 'rare' },
        { id: 'r3', name: 'Mua đồ mới', icon: '🛍️', rarity: 'legendary' },
        { id: 'r4', name: '5p lướt MXH', icon: '📱', rarity: 'common' },
        { id: 'r5', name: 'Cafe đặc biệt', icon: '☕', rarity: 'uncommon' },
        { id: 'r6', name: '15p đi dạo', icon: '🚶', rarity: 'uncommon' },
    ];

    let focusHistory = JSON.parse(localStorage.getItem('habitflow_focus_history') || '[]');

    function saveRewards() {
        localStorage.setItem('habitflow_rewards', JSON.stringify(rewardPool));
    }
    function saveHistory() {
        localStorage.setItem('habitflow_focus_history', JSON.stringify(focusHistory));
    }

    // ── INIT ──
    function init() {
        // Mode buttons
        document.querySelectorAll('.focus-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (isRunning) return;
                setMode(btn.dataset.mode);
            });
        });

        // Start/Pause
        document.getElementById('focusBtnStart').addEventListener('click', toggleTimer);
        document.getElementById('focusBtnReset').addEventListener('click', resetTimer);

        // Reward Pool Modal
        document.getElementById('openRewardPool').addEventListener('click', openRewardPoolModal);
        document.getElementById('closeRewardPool').addEventListener('click', closeRewardPoolModal);
        document.getElementById('cancelRewardPool').addEventListener('click', closeRewardPoolModal);
        document.getElementById('saveRewardPool').addEventListener('click', () => {
            saveRewards();
            closeRewardPoolModal();
            renderRewardPreview();
            renderDropRates();
            showToast('✅ Đã lưu phần thưởng!', 'success');
        });
        document.getElementById('addRewardBtn').addEventListener('click', addRewardToPool);

        // Spin Wheel
        document.getElementById('closeSpinWheel').addEventListener('click', closeSpinWheel);
        document.getElementById('spinBtn').addEventListener('click', spinWheel);
        document.getElementById('spinViewHistory').addEventListener('click', () => {
            closeSpinWheel();
            showPage('focus');
        });

        // Reward Won
        document.getElementById('claimRewardBtn').addEventListener('click', claimReward);

        // History
        document.getElementById('clearFocusHistory').addEventListener('click', () => {
            showConfirmModal({
                title: 'Xóa lịch sử',
                message: 'Bạn có chắc muốn xóa toàn bộ lịch sử tập trung?',
                confirmText: 'Xóa',
                isDanger: true,
                onConfirm: () => {
                    focusHistory = [];
                    saveHistory();
                    renderFocusHistory();
                    showToast('🗑️ Đã xóa lịch sử!', 'success');
                }
            });
        });

        // Reward Pool Modal overlay close
        document.getElementById('rewardPoolModal').addEventListener('click', (e) => {
            if (e.target.id === 'rewardPoolModal') closeRewardPoolModal();
        });

        // Time inputs - prevent click propagation & handle changes
        const timeInputMap = {
            'timeDeepWork': 'deepwork',
            'timeShortBreak': 'shortbreak',
            'timeLongBreak': 'longbreak',
            'timeCustom': 'custom',
        };

        // Load saved custom times from localStorage
        const savedTimes = JSON.parse(localStorage.getItem('habitflow_focus_times') || 'null');
        if (savedTimes) {
            Object.entries(savedTimes).forEach(([mode, mins]) => {
                if (MODES[mode]) {
                    MODES[mode].duration = mins * 60;
                }
            });
        }

        Object.entries(timeInputMap).forEach(([inputId, mode]) => {
            const input = document.getElementById(inputId);
            if (!input) return;

            // Set input value from saved config
            input.value = Math.round(MODES[mode].duration / 60);

            // Prevent click from selecting the mode button
            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('focus', (e) => e.stopPropagation());

            // On change - update the mode duration
            input.addEventListener('change', () => {
                let mins = parseInt(input.value) || 1;
                mins = Math.max(1, Math.min(180, mins));
                input.value = mins;

                MODES[mode].duration = mins * 60;
                MODES[mode].subtitle = `Stay focused for ${mins} minutes`;
                MODES[mode].points = Math.round(mins * 2);

                // Save to localStorage
                const times = {};
                Object.keys(MODES).forEach(m => {
                    times[m] = Math.round(MODES[m].duration / 60);
                });
                localStorage.setItem('habitflow_focus_times', JSON.stringify(times));

                // If this is the active mode, update timer
                if (currentMode === mode && !isRunning) {
                    timeLeft = MODES[mode].duration;
                    totalTime = MODES[mode].duration;
                    document.getElementById('focusSessionSubtitle').textContent = MODES[mode].subtitle;
                    updateTimerDisplay();
                    updateTimerRing(1);
                }
            });
        });

        // Update initial timer with loaded custom time
        timeLeft = MODES[currentMode].duration;
        totalTime = MODES[currentMode].duration;

        // Initial render
        renderAll();
    }

    function renderAll() {
        updateTimerDisplay();
        renderSessionDots();
        renderRewardPreview();
        renderDropRates();
        renderFocusHistory();
        updateSessionTarget();
    }

    // ── MODE ──
    function setMode(mode) {
        currentMode = mode;
        const config = MODES[mode];

        // Read the latest value from the corresponding time input
        const inputMap = { deepwork: 'timeDeepWork', shortbreak: 'timeShortBreak', longbreak: 'timeLongBreak', custom: 'timeCustom' };
        const input = document.getElementById(inputMap[mode]);
        if (input) {
            const mins = parseInt(input.value) || Math.round(config.duration / 60);
            config.duration = mins * 60;
            config.subtitle = `Stay focused for ${mins} minutes`;
            config.points = Math.round(mins * 2);
        }

        timeLeft = config.duration;
        totalTime = config.duration;

        document.querySelectorAll('.focus-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });

        document.getElementById('focusSessionTitle').textContent = config.label;
        document.getElementById('focusSessionSubtitle').textContent = config.subtitle;

        updateTimerDisplay();
        updateTimerRing(1);
    }

    // ── TIMER ──
    function toggleTimer() {
        if (isRunning) {
            pauseTimer();
        } else {
            startTimer();
        }
    }

    function startTimer() {
        if (timeLeft <= 0) return;
        isRunning = true;

        const btn = document.getElementById('focusBtnStart');
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> PAUSE';
        btn.classList.add('running');

        document.querySelector('.focus-timer-ring-wrap').classList.add('running');

        // Enter fullscreen for focus sessions (not breaks)
        const isBreak = currentMode === 'shortbreak' || currentMode === 'longbreak';
        if (!isBreak && typeof FocusFullscreen !== 'undefined') {
            FocusFullscreen.enter(currentMode, MODES[currentMode], timeLeft, totalTime);
        }

        // 🔊 Resume tất cả âm thanh (đã bị pause trước đó)
        if (typeof AmbientMixer !== 'undefined') AmbientMixer.resumeAudio();
        if (typeof FocusMusic !== 'undefined') FocusMusic.resumeMusic();

        timerInterval = setInterval(() => {
            timeLeft--;
            updateTimerDisplay();
            updateTimerRing(timeLeft / totalTime);

            // Sync fullscreen
            if (typeof FocusFullscreen !== 'undefined') {
                FocusFullscreen.syncTimer(timeLeft, totalTime, isRunning);
            }

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                timerInterval = null;
                isRunning = false;
                if (typeof FocusFullscreen !== 'undefined') FocusFullscreen.exit();
                onTimerComplete();
            }
        }, 1000);
    }

    function pauseTimer() {
        clearInterval(timerInterval);
        timerInterval = null;
        isRunning = false;

        const btn = document.getElementById('focusBtnStart');
        btn.innerHTML = '<i class="fa-solid fa-play"></i> RESUME';
        btn.classList.remove('running');

        document.querySelector('.focus-timer-ring-wrap').classList.remove('running');

        // 🔇 Pause tất cả âm thanh
        if (typeof AmbientMixer !== 'undefined') AmbientMixer.suspendAudio();
        if (typeof FocusMusic !== 'undefined') FocusMusic.pauseMusic();
    }

    function resetTimer() {
        clearInterval(timerInterval);
        timerInterval = null;
        isRunning = false;

        timeLeft = MODES[currentMode].duration;
        totalTime = MODES[currentMode].duration;

        const btn = document.getElementById('focusBtnStart');
        btn.innerHTML = '<i class="fa-solid fa-play"></i> START';
        btn.classList.remove('running');

        document.querySelector('.focus-timer-ring-wrap').classList.remove('running');

        updateTimerDisplay();
        updateTimerRing(1);
    }

    function updateTimerDisplay() {
        const min = Math.floor(timeLeft / 60);
        const sec = timeLeft % 60;
        document.getElementById('focusTimeDisplay').textContent =
            `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    function updateTimerRing(fraction) {
        const offset = CIRCUMFERENCE * (1 - fraction);
        const progress = document.getElementById('timerProgress');
        const glow = document.getElementById('timerGlow');
        if (progress) progress.style.strokeDashoffset = offset;
        if (glow) glow.style.strokeDashoffset = offset;
    }

    function onTimerComplete() {
        const config = MODES[currentMode];
        const isBreak = currentMode === 'shortbreak' || currentMode === 'longbreak';

        // 🔔 Phát tiếng chuông thông báo
        playCompletionBell();

        // 🔇 Tắt tất cả âm thanh (ambient + music)
        if (typeof AmbientMixer !== 'undefined') AmbientMixer.suspendAudio();
        if (typeof FocusMusic !== 'undefined') FocusMusic.pauseMusic();

        // Focus sessions (deepwork + custom) trigger reward
        if (!isBreak) {
            sessionsDone++;
            spinCharges++;
            updateSessionTarget();
            renderSessionDots();

            // Add focus history entry (reward added after spinning)
            const entry = {
                id: 'fh_' + Date.now(),
                mode: currentMode,
                duration: totalTime,
                points: config.points,
                date: new Date().toISOString(),
                reward: null,
            };
            focusHistory.unshift(entry);
            saveHistory();
            renderFocusHistory();

            // Award XP
            // Base XP = mode points, Bonus = 5 XP per 10 mins above 25 min
            const baseXP = config.points;
            const bonusXP = Math.max(0, Math.floor((totalTime - 25 * 60) / (10 * 60)) * 5);
            const totalXP = baseXP + bonusXP;
            if (typeof FocusXP !== 'undefined') {
                FocusXP.addXP(totalXP, config.points, totalTime);
                // Sync to Google Sheets in background
                FocusXP.syncSession(entry);
            }

            // Show spin wheel
            openSpinWheel(config);

            // Update daily tracker
            if (typeof DailyFocusTracker !== 'undefined') DailyFocusTracker.render();

            showToast('🎉 Phiên tập trung hoàn thành! Quay thưởng ngay!', 'success');
        } else {
            showToast('✅ Nghỉ ngơi xong! Bắt đầu phiên tập trung mới nhé!', 'success');
            // Auto switch to deep work
            setMode('deepwork');
        }

        // Reset button
        const btn = document.getElementById('focusBtnStart');
        btn.innerHTML = '<i class="fa-solid fa-play"></i> START';
        btn.classList.remove('running');
        document.querySelector('.focus-timer-ring-wrap').classList.remove('running');

        // Reset timer for the mode
        timeLeft = config.duration;
        totalTime = config.duration;
        updateTimerDisplay();
        updateTimerRing(1);
    }

    // 🔔 Tiếng chuông hoàn thành (Web Audio API - không cần file mp3)
    function playCompletionBell() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();

            // 3 nốt chuông tăng dần → cảm giác "hoàn thành!"
            const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
            const startTimes = [0, 0.2, 0.4];

            notes.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.value = freq;

                // Envelope: attack → sustain → decay
                gain.gain.setValueAtTime(0, ctx.currentTime + startTimes[i]);
                gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + startTimes[i] + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTimes[i] + 1.2);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(ctx.currentTime + startTimes[i]);
                osc.stop(ctx.currentTime + startTimes[i] + 1.5);
            });

            // Thêm overtone cho tiếng chuông trong hơn
            const bellOsc = ctx.createOscillator();
            const bellGain = ctx.createGain();
            bellOsc.type = 'triangle';
            bellOsc.frequency.value = 1046.5; // C6 (octave cao)
            bellGain.gain.setValueAtTime(0, ctx.currentTime + 0.4);
            bellGain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.45);
            bellGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.0);
            bellOsc.connect(bellGain);
            bellGain.connect(ctx.destination);
            bellOsc.start(ctx.currentTime + 0.4);
            bellOsc.stop(ctx.currentTime + 2.5);

            // Cleanup
            setTimeout(() => ctx.close(), 3000);
        } catch (e) {
            console.log('🔔 Bell sound failed:', e.message);
        }
    }

    // ── SESSION DOTS ──
    function renderSessionDots() {
        const container = document.getElementById('focusSessionDots');
        if (!container) return;

        let html = '';
        for (let i = 0; i < sessionsGoal; i++) {
            const isDone = i < sessionsDone;
            const isCurrent = i === sessionsDone;
            const cls = isDone ? 'completed' : isCurrent ? 'current' : 'locked';
            const icon = isDone ? '<i class="fa-solid fa-check"></i>' : isCurrent ? '<i class="fa-solid fa-crosshairs"></i>' : '<i class="fa-solid fa-lock"></i>';

            if (i > 0) {
                html += `<div class="focus-dot-line ${isDone ? 'completed' : ''}"></div>`;
            }

            html += `
                <div class="focus-dot-group">
                    <div class="focus-dot ${cls}">${icon}</div>
                    <span class="focus-dot-label">Session ${i + 1}</span>
                </div>
            `;
        }
        container.innerHTML = html;
    }

    function updateSessionTarget() {
        const doneEl = document.getElementById('focusSessionsDone');
        if (doneEl) doneEl.textContent = sessionsDone;
    }

    // ── REWARD PREVIEW ──
    function renderRewardPreview() {
        const container = document.getElementById('rewardPreviewList');
        if (!container) return;

        if (rewardPool.length === 0) {
            container.innerHTML = '<div class="empty-state-sm">Chưa có phần thưởng. Nhấn Edit Pool để thêm!</div>';
            return;
        }

        // Show top 4 rewards
        const showItems = rewardPool.slice(0, 4);
        container.innerHTML = showItems.map(r => {
            const cfg = RARITY_CONFIG[r.rarity];
            const weight = cfg.weight;
            return `
                <div class="reward-item">
                    <div class="reward-item-icon ${r.rarity}">${r.icon}</div>
                    <div class="reward-item-info">
                        <div class="reward-item-name">${r.name}</div>
                        <span class="reward-item-rarity ${r.rarity}">${cfg.label}</span>
                    </div>
                    <span class="reward-item-pct">${weight}%</span>
                </div>
            `;
        }).join('');
    }

    // ── DROP RATES ──
    function renderDropRates() {
        const container = document.getElementById('dropRateBars');
        if (!container) return;

        const rarities = ['common', 'uncommon', 'rare', 'legendary'];
        container.innerHTML = rarities.map(r => {
            const cfg = RARITY_CONFIG[r];
            const height = cfg.weight; // Use weight as bar height percentage
            return `
                <div class="drop-rate-item">
                    <div class="drop-rate-bar ${r}" style="height: ${height}px"></div>
                    <span class="drop-rate-label">${cfg.label}</span>
                </div>
            `;
        }).join('');

        // Luck bonus
        const luckBonus = sessionsDone >= 4 ? 1.2 : sessionsDone * 0.3;
        const luckEl = document.getElementById('luckBonusValue');
        if (luckEl) luckEl.textContent = `+${luckBonus.toFixed(1)}%`;
    }

    // ── REWARD POOL MODAL ──
    function openRewardPoolModal() {
        document.getElementById('rewardPoolModal').classList.add('show');
        renderRewardPoolList();
    }

    function closeRewardPoolModal() {
        document.getElementById('rewardPoolModal').classList.remove('show');
    }

    function renderRewardPoolList() {
        const container = document.getElementById('rewardPoolList');
        if (!container) return;

        if (rewardPool.length === 0) {
            container.innerHTML = '<div class="empty-state-sm">Chưa có phần thưởng nào</div>';
            return;
        }

        container.innerHTML = rewardPool.map(r => {
            const cfg = RARITY_CONFIG[r.rarity];
            const isEditing = editingRewardId === r.id;
            return `
                <div class="reward-pool-item ${isEditing ? 'editing' : ''}" data-id="${r.id}">
                    <div class="reward-item-icon ${r.rarity}">${r.icon}</div>
                    <div class="reward-item-info">
                        <div class="reward-item-name">${r.name}</div>
                        <span class="reward-item-rarity ${r.rarity}">${cfg.label}</span>
                    </div>
                    <div class="reward-action-btns">
                        <button class="reward-edit-action-btn" onclick="FocusTimer.editReward('${r.id}')" title="Chỉnh sửa">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="reward-delete-btn" onclick="FocusTimer.removeReward('${r.id}')" title="Xóa">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function addRewardToPool() {
        const name = document.getElementById('rewardNameInput').value.trim();
        const icon = document.getElementById('rewardIconInput').value.trim() || '🎁';
        const rarity = document.getElementById('rewardRarityInput').value;

        if (!name) {
            showToast('Vui lòng nhập tên phần thưởng!', 'error');
            return;
        }

        if (editingRewardId) {
            // Update existing reward
            const idx = rewardPool.findIndex(r => r.id === editingRewardId);
            if (idx !== -1) {
                rewardPool[idx].name = name;
                rewardPool[idx].icon = icon;
                rewardPool[idx].rarity = rarity;
            }
            editingRewardId = null;
            updateAddRewardButton(false);
            showToast('✅ Đã cập nhật phần thưởng!', 'success');
        } else {
            // Add new reward
            rewardPool.push({
                id: 'r_' + Date.now(),
                name,
                icon,
                rarity,
            });
            showToast('✅ Đã thêm phần thưởng!', 'success');
        }

        saveRewards();
        renderRewardPoolList();
        renderRewardPreview();
        renderDropRates();

        // Clear inputs
        document.getElementById('rewardNameInput').value = '';
        document.getElementById('rewardIconInput').value = '';
        document.getElementById('rewardRarityInput').value = 'common';
    }

    function editReward(id) {
        const reward = rewardPool.find(r => r.id === id);
        if (!reward) return;

        editingRewardId = id;

        // Fill form with reward data
        document.getElementById('rewardNameInput').value = reward.name;
        document.getElementById('rewardIconInput').value = reward.icon;
        document.getElementById('rewardRarityInput').value = reward.rarity;

        // Focus the name input
        document.getElementById('rewardNameInput').focus();

        // Update button text
        updateAddRewardButton(true);

        // Highlight the editing item
        renderRewardPoolList();
    }

    function cancelEditReward() {
        editingRewardId = null;
        document.getElementById('rewardNameInput').value = '';
        document.getElementById('rewardIconInput').value = '';
        document.getElementById('rewardRarityInput').value = 'common';
        updateAddRewardButton(false);
        renderRewardPoolList();
    }

    function updateAddRewardButton(isEditing) {
        const btn = document.getElementById('addRewardBtn');
        const cancelBtn = document.getElementById('cancelEditRewardBtn');
        if (btn) {
            if (isEditing) {
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Cập nhật';
                btn.classList.add('editing-mode');
            } else {
                btn.innerHTML = '<i class="fa-solid fa-plus"></i> Thêm';
                btn.classList.remove('editing-mode');
            }
        }
        if (cancelBtn) {
            cancelBtn.style.display = isEditing ? 'inline-flex' : 'none';
        }
    }

    function removeReward(id) {
        rewardPool = rewardPool.filter(r => r.id !== id);
        saveRewards();
        renderRewardPoolList();
        renderRewardPreview();
        renderDropRates();
    }

    // ── SPIN WHEEL ──
    function openSpinWheel(config) {
        const modal = document.getElementById('spinWheelModal');
        modal.classList.add('show');

        // Update stats
        const mins = Math.floor(config.duration / 60);
        const secs = config.duration % 60;
        document.getElementById('spinTimeFocused').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        document.getElementById('spinFocusPoints').textContent = `+${config.points}`;
        document.getElementById('spinXPGained').textContent = `+${Math.round(config.points * 0.2)}% XP`;
        document.getElementById('spinCharges').textContent = `${spinCharges} CHARGE${spinCharges > 1 ? 'S' : ''}`;

        // Stars based on sessions done
        const starsContainer = document.getElementById('spinStars');
        const numStars = Math.min(3, Math.ceil(sessionsDone / 2));
        starsContainer.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            starsContainer.innerHTML += `<i class="fa-${i < numStars ? 'solid' : 'regular'} fa-star"></i>`;
        }

        // Possible rewards list
        renderSpinPossibleRewards();

        // Draw wheel
        drawSpinWheel(0);

        // Enable spin button
        const btn = document.getElementById('spinBtn');
        btn.disabled = false;
    }

    function closeSpinWheel() {
        document.getElementById('spinWheelModal').classList.remove('show');
    }

    function renderSpinPossibleRewards() {
        const container = document.getElementById('spinPossibleRewards');
        if (!container) return;

        if (rewardPool.length === 0) {
            container.innerHTML = '<div class="empty-state-sm">Không có phần thưởng</div>';
            return;
        }

        container.innerHTML = rewardPool.map(r => {
            const cfg = RARITY_CONFIG[r.rarity];
            return `
                <div class="spin-reward-item">
                    <div class="spin-reward-item-icon ${r.rarity}">${r.icon}</div>
                    <div class="spin-reward-info">
                        <div class="spin-reward-name">${r.name}</div>
                        <div class="spin-reward-detail">${cfg.label} · ${cfg.weight}%</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function drawSpinWheel(rotation) {
        const canvas = document.getElementById('spinWheelCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        const center = size / 2;
        const outerRadius = (size / 2) - 8;
        const radius = outerRadius - 14;

        ctx.clearRect(0, 0, size, size);

        const items = rewardPool.length > 0 ? rewardPool : [{ name: 'Thêm phần thưởng!', icon: '❓', rarity: 'common' }];
        const sliceAngle = (2 * Math.PI) / items.length;

        // ── OUTER RING with glow ──
        ctx.save();
        ctx.translate(center, center);

        // Outer dark ring
        ctx.beginPath();
        ctx.arc(0, 0, outerRadius, 0, 2 * Math.PI);
        ctx.strokeStyle = '#1c2128';
        ctx.lineWidth = 14;
        ctx.stroke();

        // Outer ring border (cyan glow)
        ctx.beginPath();
        ctx.arc(0, 0, outerRadius + 5, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(0, 0, outerRadius - 5, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Dot markers around the rim
        const numDots = items.length * 4;
        for (let i = 0; i < numDots; i++) {
            const angle = (i / numDots) * 2 * Math.PI;
            const dotX = Math.cos(angle) * outerRadius;
            const dotY = Math.sin(angle) * outerRadius;
            ctx.beginPath();
            ctx.arc(dotX, dotY, i % 4 === 0 ? 3 : 1.5, 0, 2 * Math.PI);
            ctx.fillStyle = i % 4 === 0 ? '#06b6d4' : 'rgba(255,255,255,0.3)';
            ctx.fill();
        }

        ctx.restore();

        // ── WHEEL SLICES ──
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(rotation);

        items.forEach((item, i) => {
            const startAngle = i * sliceAngle;
            const endAngle = startAngle + sliceAngle;

            // Slice fill
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, radius, startAngle, endAngle);
            ctx.closePath();

            // Gradient fill for each slice
            const midAngle = startAngle + sliceAngle / 2;
            const grd = ctx.createRadialGradient(0, 0, radius * 0.3, 0, 0, radius);
            const baseColor = WHEEL_COLORS[i % WHEEL_COLORS.length];
            grd.addColorStop(0, baseColor + 'cc');
            grd.addColorStop(1, baseColor);
            ctx.fillStyle = grd;
            ctx.fill();

            // Slice border
            ctx.strokeStyle = 'rgba(0,0,0,0.25)';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Text & Icon
            ctx.save();
            ctx.rotate(startAngle + sliceAngle / 2);
            ctx.textAlign = 'right';

            // Text shadow for readability
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 3;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;
            ctx.fillStyle = '#fff';

            // Emoji icon
            ctx.font = '22px sans-serif';
            ctx.fillText(item.icon, radius - 18, 7);

            // Name
            ctx.font = 'bold 11px Inter, system-ui, sans-serif';
            const name = item.name.length > 10 ? item.name.substring(0, 9) + '…' : item.name;
            ctx.fillText(name, radius - 44, 5);

            ctx.shadowBlur = 0;
            ctx.restore();
        });

        // Inner dark hub circle
        ctx.beginPath();
        ctx.arc(0, 0, 40, 0, 2 * Math.PI);
        const hubGrd = ctx.createRadialGradient(0, 0, 10, 0, 0, 40);
        hubGrd.addColorStop(0, '#1c2128');
        hubGrd.addColorStop(1, '#0d1117');
        ctx.fillStyle = hubGrd;
        ctx.fill();
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.restore();
    }

    function spinWheel() {
        if (isSpinning || spinCharges <= 0 || rewardPool.length === 0) {
            if (rewardPool.length === 0) {
                showToast('Thêm phần thưởng trước khi quay!', 'error');
            }
            return;
        }

        spinCharges--;
        isSpinning = true;
        document.getElementById('spinBtn').disabled = true;
        document.getElementById('spinCharges').textContent = `${spinCharges} CHARGE${spinCharges !== 1 ? 'S' : ''}`;

        // Pick winner by rarity weight
        const winner = pickWeightedReward();
        const winnerIndex = rewardPool.indexOf(winner);
        const sliceAngle = (2 * Math.PI) / rewardPool.length;

        // Calculate target angle: the pointer is at top (12 o'clock = -90deg = -PI/2 from right)
        // We want the winner's slice center to align with the top
        // But the canvas rotation starts from 3 o'clock, so the top is at -PI/2
        const sliceCenter = winnerIndex * sliceAngle + sliceAngle / 2;
        // We want (rotation + sliceCenter) % 2PI = 3PI/2 (top in canvas coords since canvas 0 is 3 o'clock, top is -PI/2 = 3PI/2)
        const targetStop = (3 * Math.PI / 2) - sliceCenter;

        // Add extra full rotations for visual effect
        const extraRotations = 5 + Math.random() * 3; // 5-8 full rotations
        const targetAngle = spinAngle + extraRotations * 2 * Math.PI + (targetStop - (spinAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

        const startAngle = spinAngle;
        const totalAngle = targetAngle - startAngle;
        const duration = 4000 + Math.random() * 1000; // 4-5s
        const startTime = performance.now();

        function animateSpin(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease out cubic for deceleration effect
            const eased = 1 - Math.pow(1 - progress, 3);

            spinAngle = startAngle + totalAngle * eased;
            drawSpinWheel(spinAngle);

            if (progress < 1) {
                requestAnimationFrame(animateSpin);
            } else {
                isSpinning = false;
                spinAngle = targetAngle;
                drawSpinWheel(spinAngle);

                // Show result after short delay
                setTimeout(() => {
                    showRewardWon(winner);

                    // Update history with reward
                    if (focusHistory.length > 0 && !focusHistory[0].reward) {
                        focusHistory[0].reward = { name: winner.name, icon: winner.icon, rarity: winner.rarity };
                        saveHistory();
                        renderFocusHistory();
                    }
                }, 500);
            }
        }

        requestAnimationFrame(animateSpin);
    }

    function pickWeightedReward() {
        // Group by rarity, then pick rarity based on weight, then random item from that rarity
        const rarityCounts = {};
        rewardPool.forEach(r => {
            rarityCounts[r.rarity] = (rarityCounts[r.rarity] || 0) + 1;
        });

        // Build weighted rarity pool
        const rarityPool = [];
        Object.entries(RARITY_CONFIG).forEach(([key, cfg]) => {
            if (rarityCounts[key]) {
                rarityPool.push({ rarity: key, weight: cfg.weight });
            }
        });

        // Pick rarity
        const totalWeight = rarityPool.reduce((sum, r) => sum + r.weight, 0);
        let rand = Math.random() * totalWeight;
        let selectedRarity = rarityPool[0]?.rarity || 'common';
        for (const r of rarityPool) {
            rand -= r.weight;
            if (rand <= 0) {
                selectedRarity = r.rarity;
                break;
            }
        }

        // Pick random item from that rarity
        const candidates = rewardPool.filter(r => r.rarity === selectedRarity);
        if (candidates.length === 0) return rewardPool[Math.floor(Math.random() * rewardPool.length)];
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    function showRewardWon(reward) {
        const overlay = document.getElementById('rewardWonOverlay');
        document.getElementById('rewardWonIcon').textContent = reward.icon;
        document.getElementById('rewardWonName').textContent = reward.name;
        const rarityEl = document.getElementById('rewardWonRarity');
        rarityEl.textContent = RARITY_CONFIG[reward.rarity].label;
        rarityEl.className = 'reward-won-rarity ' + reward.rarity;
        overlay.classList.add('show');
    }

    function claimReward() {
        document.getElementById('rewardWonOverlay').classList.remove('show');

        // If still has charges, keep modal open; otherwise close
        if (spinCharges > 0) {
            document.getElementById('spinBtn').disabled = false;
            document.getElementById('spinCharges').textContent = `${spinCharges} CHARGE${spinCharges !== 1 ? 'S' : ''}`;
        } else {
            closeSpinWheel();
        }

        showToast('🎁 Phần thưởng đã được nhận!', 'success');
    }

    // ── FOCUS HISTORY ──
    function renderFocusHistory() {
        const container = document.getElementById('focusHistoryList');
        if (!container) return;

        if (focusHistory.length === 0) {
            container.innerHTML = '<div class="empty-state-sm">Chưa có phiên tập trung nào</div>';
            return;
        }

        container.innerHTML = focusHistory.slice(0, 20).map(h => {
            const config = MODES[h.mode] || MODES.deepwork;
            const mins = Math.floor(h.duration / 60);
            const dt = new Date(h.date);
            const dateStr = `${dt.getDate()}/${dt.getMonth() + 1} – ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
            const rewardHtml = h.reward
                ? `<div class="fh-reward">
                        <div class="fh-reward-name">${h.reward.icon} ${h.reward.name}</div>
                        <div class="fh-reward-rarity ${h.reward.rarity}">${RARITY_CONFIG[h.reward.rarity]?.label || ''}</div>
                   </div>`
                : `<div class="fh-reward"><div class="fh-reward-name" style="color:var(--text-dim)">Chưa quay</div></div>`;

            return `
                <div class="focus-history-item">
                    <div class="fh-icon"><i class="fa-solid fa-brain"></i></div>
                    <div class="fh-info">
                        <div class="fh-title">${config.label} – ${mins} phút</div>
                        <div class="fh-meta">${dateStr} · +${h.points} pts</div>
                    </div>
                    ${rewardHtml}
                </div>
            `;
        }).join('');
    }

    // Public API
    return {
        init,
        removeReward: (id) => {
            removeReward(id);
        },
        editReward: (id) => {
            editReward(id);
        },
        cancelEditReward: () => {
            cancelEditReward();
        },
    };
})();

// Initialize Focus Timer when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    FocusTimer.init();
    FocusMusic.init();
});

// ============================================================
// 🎵 FOCUS MUSIC MODULE
// ============================================================
const FocusMusic = (() => {
    let playlist = JSON.parse(localStorage.getItem('habitflow_music_playlist') || '[]');
    let currentTrackId = null;

    function savePlaylist() {
        localStorage.setItem('habitflow_music_playlist', JSON.stringify(playlist));
    }

    // 📡 Sync track lên API (background, không block UI)
    function syncTrackToApi(track) {
        if (!API_URL) return;
        fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ action: 'savePlaylistTrack', track }),
        }).then(r => r.json()).then(d => {
            if (d.success) console.log('🎵 Track synced to API:', track.name);
        }).catch(e => console.log('🎵 Sync failed:', e.message));
    }

    // 📡 Xóa track khỏi API
    function deleteTrackFromApi(trackId) {
        if (!API_URL) return;
        fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ action: 'deletePlaylistTrack', trackId }),
        }).then(r => r.json()).then(d => {
            if (d.success) console.log('🎵 Track deleted from API:', trackId);
        }).catch(e => console.log('🎵 Delete failed:', e.message));
    }

    // 📡 Merge playlist từ API vào local
    function mergePlaylistFromApi(apiPlaylist) {
        if (!apiPlaylist || !Array.isArray(apiPlaylist)) return;
        let changed = false;
        apiPlaylist.forEach(apiTrack => {
            if (!playlist.find(t => t.videoId === apiTrack.videoId)) {
                playlist.push(apiTrack);
                changed = true;
            }
        });
        if (changed) {
            savePlaylist();
            renderPlaylist();
            console.log('🎵 Playlist merged from API, total:', playlist.length);
        }
    }

    // Extract YouTube video ID from various URL formats
    function extractYouTubeId(url) {
        if (!url) return null;
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
            /^([a-zA-Z0-9_-]{11})$/,
        ];
        for (const pat of patterns) {
            const match = url.match(pat);
            if (match) return match[1];
        }
        return null;
    }

    function init() {
        // Add button
        document.getElementById('addMusicBtn').addEventListener('click', addTrack);

        // Enter key on inputs
        document.getElementById('musicLinkInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addTrack();
        });
        document.getElementById('musicNameInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addTrack();
        });

        // Minimize toggle
        document.getElementById('musicMinimize').addEventListener('click', () => {
            const btn = document.getElementById('musicMinimize');
            const content = document.getElementById('musicContent');
            btn.classList.toggle('collapsed');
            content.classList.toggle('collapsed');
        });

        // Suggestion chips
        document.querySelectorAll('.music-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const url = chip.dataset.url;
                const name = chip.dataset.name;
                const videoId = extractYouTubeId(url);
                if (!videoId) return;

                // Check if already in playlist
                const exists = playlist.find(t => t.videoId === videoId);
                if (exists) {
                    playTrack(exists.id);
                    return;
                }

                // Add and play
                const track = {
                    id: 'mt_' + Date.now(),
                    name: name || 'YouTube Video',
                    videoId,
                    url,
                    addedAt: new Date().toISOString(),
                };
                playlist.push(track);
                savePlaylist();
                syncTrackToApi(track); // 📡 Sync lên API
                renderPlaylist();
                playTrack(track.id);
                showToast('🎵 Đã thêm và phát nhạc!', 'success');
            });
        });

        renderPlaylist();
    }

    function addTrack() {
        const linkInput = document.getElementById('musicLinkInput');
        const nameInput = document.getElementById('musicNameInput');
        const url = linkInput.value.trim();
        const name = nameInput.value.trim();

        if (!url) {
            showToast('Vui lòng dán link YouTube!', 'error');
            return;
        }

        const videoId = extractYouTubeId(url);
        if (!videoId) {
            showToast('Link YouTube không hợp lệ!', 'error');
            return;
        }

        // Check duplicate
        if (playlist.find(t => t.videoId === videoId)) {
            showToast('Bài nhạc này đã có trong playlist!', 'error');
            return;
        }

        const track = {
            id: 'mt_' + Date.now(),
            name: name || `YouTube Video (${videoId})`,
            videoId,
            url,
            addedAt: new Date().toISOString(),
        };

        playlist.push(track);
        savePlaylist();
        syncTrackToApi(track); // 📡 Sync lên API
        renderPlaylist();

        // Clear inputs
        linkInput.value = '';
        nameInput.value = '';

        // Auto-play
        playTrack(track.id);

        showToast('🎵 Đã thêm nhạc vào playlist!', 'success');
    }

    function removeTrack(id) {
        playlist = playlist.filter(t => t.id !== id);
        savePlaylist();
        deleteTrackFromApi(id); // 📡 Xóa khỏi API
        renderPlaylist();

        // If removing current track, stop player
        if (currentTrackId === id) {
            stopPlayer();
        }
    }

    function playTrack(id) {
        const track = playlist.find(t => t.id === id);
        if (!track) return;

        currentTrackId = id;

        // Hide empty, show frame
        document.getElementById('musicPlayerEmpty').style.display = 'none';
        const frame = document.getElementById('musicPlayerFrame');
        frame.style.display = 'block';
        const iframe = document.getElementById('musicIframe');
        iframe.src = `https://www.youtube.com/embed/${track.videoId}?autoplay=1&rel=0&enablejsapi=1`;

        // Now playing bar
        const nowPlaying = document.getElementById('musicNowPlaying');
        nowPlaying.style.display = 'flex';
        document.getElementById('musicNowPlayingName').textContent = track.name;

        // Update playlist UI
        renderPlaylist();
    }

    function stopPlayer() {
        currentTrackId = null;
        document.getElementById('musicPlayerEmpty').style.display = 'flex';
        document.getElementById('musicPlayerFrame').style.display = 'none';
        document.getElementById('musicIframe').src = '';
        document.getElementById('musicNowPlaying').style.display = 'none';
        renderPlaylist();
    }

    function renderPlaylist() {
        const container = document.getElementById('musicPlaylist');
        const countEl = document.getElementById('musicPlaylistCount');

        countEl.textContent = `${playlist.length} bài`;

        if (playlist.length === 0) {
            container.innerHTML = `
                <div class="music-playlist-empty">
                    <i class="fa-regular fa-face-smile"></i>
                    <p>Thêm nhạc yêu thích để tập trung tốt hơn!</p>
                </div>
            `;
            return;
        }

        container.innerHTML = playlist.map(track => {
            const isPlaying = track.id === currentTrackId;
            return `
                <div class="music-track ${isPlaying ? 'playing' : ''}" data-id="${track.id}">
                    <div class="music-track-play" onclick="FocusMusic.play('${track.id}')">
                        <i class="fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}"></i>
                    </div>
                    <div class="music-track-info" onclick="FocusMusic.play('${track.id}')">
                        <div class="music-track-name">${track.name}</div>
                        <div class="music-track-src"><i class="fa-brands fa-youtube"></i> YouTube</div>
                    </div>
                    <button class="music-track-delete" onclick="event.stopPropagation(); FocusMusic.remove('${track.id}')" title="Xóa">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
        }).join('');
    }

    // Public API
    return {
        init,
        play: (id) => {
            if (currentTrackId === id) {
                stopPlayer();
            } else {
                playTrack(id);
            }
        },
        remove: (id) => removeTrack(id),
        getPlaylist: () => playlist,
        getCurrentTrackId: () => currentTrackId,
        // 🔇 Pause/Resume YouTube iframe
        pauseMusic: () => {
            const iframe = document.getElementById('musicIframe');
            if (iframe && iframe.src && currentTrackId) {
                iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
            }
        },
        resumeMusic: () => {
            const iframe = document.getElementById('musicIframe');
            if (iframe && iframe.src && currentTrackId) {
                iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
            }
        },
        // 📡 Merge playlist từ API
        mergeFromApi: mergePlaylistFromApi,
    };
})();

// ============================================================
// 🎧 AMBIENT SOUND MIXER MODULE (Web Audio API)
// ============================================================
const AmbientMixer = (() => {
    let audioCtx = null;
    let masterGain = null;
    const channels = {};
    let activePreset = null;

    // Sound definitions
    const SOUNDS = {
        rain: { toggle: 'toggleRain', vol: 'volRain', label: 'Rain' },
        thunder: { toggle: 'toggleThunder', vol: 'volThunder', label: 'Thunder' },
        fire: { toggle: 'toggleFire', vol: 'volFire', label: 'Fireplace' },
        ocean: { toggle: 'toggleOcean', vol: 'volOcean', label: 'Ocean' },
        birds: { toggle: 'toggleBirds', vol: 'volBirds', label: 'Birds' },
        wind: { toggle: 'toggleWind', vol: 'volWind', label: 'Wind' },
        cafe: { toggle: 'toggleCafe', vol: 'volCafe', label: 'Café' },
        crickets: { toggle: 'toggleCrickets', vol: 'volCrickets', label: 'Crickets' },
    };

    const PRESETS = {
        rainforest: { rain: 70, birds: 55, wind: 30, thunder: 0, fire: 0, ocean: 0, cafe: 0, crickets: 20 },
        coffeeshop: { cafe: 65, rain: 25, fire: 0, birds: 0, wind: 0, thunder: 0, ocean: 0, crickets: 0 },
        beach: { ocean: 75, wind: 35, birds: 40, rain: 0, thunder: 0, fire: 0, cafe: 0, crickets: 0 },
        library: { rain: 15, cafe: 10, fire: 0, birds: 0, wind: 5, thunder: 0, ocean: 0, crickets: 0 },
        storm: { rain: 80, thunder: 60, wind: 50, fire: 0, birds: 0, ocean: 0, cafe: 0, crickets: 0 },
        off: { rain: 0, thunder: 0, fire: 0, ocean: 0, birds: 0, wind: 0, cafe: 0, crickets: 0 },
    };

    function ensureAudioCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 0.7;
            masterGain.connect(audioCtx.destination);
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }

    // ── NOISE GENERATORS ──────────────────────────
    function createWhiteNoise() {
        const bufferSize = audioCtx.sampleRate * 4;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        return source;
    }

    // ── SOUND FACTORY ─────────────────────────────
    function createSound(type) {
        ensureAudioCtx();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        gain.connect(masterGain);
        const nodes = [];

        switch (type) {
            case 'rain': {
                const noise = createWhiteNoise();
                const bp = audioCtx.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = 800;
                bp.Q.value = 0.5;
                const hp = audioCtx.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 200;
                noise.connect(bp);
                bp.connect(hp);
                hp.connect(gain);
                noise.start();
                nodes.push(noise);
                break;
            }
            case 'thunder': {
                const noise = createWhiteNoise();
                const lp = audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 150;
                lp.Q.value = 1;
                const rumbleGain = audioCtx.createGain();
                rumbleGain.gain.value = 0.6;
                noise.connect(lp);
                lp.connect(rumbleGain);
                rumbleGain.connect(gain);
                noise.start();
                nodes.push(noise);
                // Random rumble bursts
                const burstInterval = setInterval(() => {
                    if (!channels.thunder || !channels.thunder.active) {
                        clearInterval(burstInterval);
                        return;
                    }
                    const now = audioCtx.currentTime;
                    rumbleGain.gain.setValueAtTime(0.3, now);
                    rumbleGain.gain.linearRampToValueAtTime(1.5, now + 0.1);
                    rumbleGain.gain.exponentialRampToValueAtTime(0.3, now + 2 + Math.random() * 2);
                }, 4000 + Math.random() * 8000);
                nodes._interval = burstInterval;
                break;
            }
            case 'fire': {
                const noise = createWhiteNoise();
                const lp = audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 400;
                const crackleGain = audioCtx.createGain();
                // Modulate for crackling
                const lfo = audioCtx.createOscillator();
                lfo.type = 'sawtooth';
                lfo.frequency.value = 3 + Math.random() * 5;
                const lfoGain = audioCtx.createGain();
                lfoGain.gain.value = 0.15;
                lfo.connect(lfoGain);
                lfoGain.connect(crackleGain.gain);
                crackleGain.gain.value = 0.5;
                noise.connect(lp);
                lp.connect(crackleGain);
                crackleGain.connect(gain);
                noise.start();
                lfo.start();
                nodes.push(noise, lfo);
                break;
            }
            case 'ocean': {
                const noise = createWhiteNoise();
                const lp = audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 500;
                const waveGain = audioCtx.createGain();
                waveGain.gain.value = 0.5;
                // Slow LFO for wave swell
                const lfo = audioCtx.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = 0.12;
                const lfoGain = audioCtx.createGain();
                lfoGain.gain.value = 0.4;
                lfo.connect(lfoGain);
                lfoGain.connect(waveGain.gain);
                noise.connect(lp);
                lp.connect(waveGain);
                waveGain.connect(gain);
                noise.start();
                lfo.start();
                nodes.push(noise, lfo);
                break;
            }
            case 'birds': {
                // Random bird chirps using oscillators
                const birdInterval = setInterval(() => {
                    if (!channels.birds || !channels.birds.active) {
                        clearInterval(birdInterval);
                        return;
                    }
                    const chirpGain = audioCtx.createGain();
                    chirpGain.gain.value = 0;
                    chirpGain.connect(gain);
                    const osc = audioCtx.createOscillator();
                    osc.type = 'sine';
                    const baseFreq = 2000 + Math.random() * 3000;
                    osc.frequency.value = baseFreq;
                    osc.connect(chirpGain);
                    const now = audioCtx.currentTime;
                    const dur = 0.05 + Math.random() * 0.15;
                    // Chirp envelope
                    chirpGain.gain.setValueAtTime(0, now);
                    chirpGain.gain.linearRampToValueAtTime(0.15, now + dur * 0.3);
                    chirpGain.gain.linearRampToValueAtTime(0, now + dur);
                    // Frequency slide
                    osc.frequency.setValueAtTime(baseFreq, now);
                    osc.frequency.linearRampToValueAtTime(baseFreq * (1 + Math.random() * 0.3), now + dur * 0.5);
                    osc.frequency.linearRampToValueAtTime(baseFreq * 0.9, now + dur);
                    osc.start(now);
                    osc.stop(now + dur + 0.01);
                    // Sometimes do double chirp
                    if (Math.random() > 0.5) {
                        const osc2 = audioCtx.createOscillator();
                        osc2.type = 'sine';
                        osc2.frequency.value = baseFreq * 1.2;
                        osc2.connect(chirpGain);
                        const delay = dur + 0.05;
                        chirpGain.gain.setValueAtTime(0, now + delay);
                        chirpGain.gain.linearRampToValueAtTime(0.12, now + delay + dur * 0.3);
                        chirpGain.gain.linearRampToValueAtTime(0, now + delay + dur);
                        osc2.start(now + delay);
                        osc2.stop(now + delay + dur + 0.01);
                    }
                }, 300 + Math.random() * 1500);
                nodes._interval = birdInterval;
                break;
            }
            case 'wind': {
                const noise = createWhiteNoise();
                const lp = audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 300;
                const windGain = audioCtx.createGain();
                windGain.gain.value = 0.5;
                // Slow modulation
                const lfo = audioCtx.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = 0.08;
                const lfoGain = audioCtx.createGain();
                lfoGain.gain.value = 0.3;
                lfo.connect(lfoGain);
                lfoGain.connect(windGain.gain);
                // Higher layer
                const hp = audioCtx.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 100;
                noise.connect(lp);
                lp.connect(hp);
                hp.connect(windGain);
                windGain.connect(gain);
                noise.start();
                lfo.start();
                nodes.push(noise, lfo);
                break;
            }
            case 'cafe': {
                // Pink-ish noise for cafe ambience
                const noise = createWhiteNoise();
                const lp = audioCtx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 2000;
                const bp = audioCtx.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = 600;
                bp.Q.value = 0.3;
                const cafeGain = audioCtx.createGain();
                cafeGain.gain.value = 0.3;
                // Subtle modulation for "murmur"
                const lfo = audioCtx.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = 0.5;
                const lfoGain = audioCtx.createGain();
                lfoGain.gain.value = 0.1;
                lfo.connect(lfoGain);
                lfoGain.connect(cafeGain.gain);
                noise.connect(lp);
                lp.connect(bp);
                bp.connect(cafeGain);
                cafeGain.connect(gain);
                noise.start();
                lfo.start();
                nodes.push(noise, lfo);
                break;
            }
            case 'crickets': {
                const cricketInterval = setInterval(() => {
                    if (!channels.crickets || !channels.crickets.active) {
                        clearInterval(cricketInterval);
                        return;
                    }
                    const cricketGain = audioCtx.createGain();
                    cricketGain.gain.value = 0;
                    cricketGain.connect(gain);
                    const osc = audioCtx.createOscillator();
                    osc.type = 'sine';
                    const freq = 4000 + Math.random() * 2000;
                    osc.frequency.value = freq;
                    osc.connect(cricketGain);
                    const now = audioCtx.currentTime;
                    const numPulses = 3 + Math.floor(Math.random() * 5);
                    const pulseDur = 0.02;
                    const pulseGap = 0.03;
                    for (let p = 0; p < numPulses; p++) {
                        const t = now + p * (pulseDur + pulseGap);
                        cricketGain.gain.setValueAtTime(0, t);
                        cricketGain.gain.linearRampToValueAtTime(0.08, t + pulseDur * 0.5);
                        cricketGain.gain.linearRampToValueAtTime(0, t + pulseDur);
                    }
                    const totalDur = numPulses * (pulseDur + pulseGap);
                    osc.start(now);
                    osc.stop(now + totalDur + 0.01);
                }, 200 + Math.random() * 800);
                nodes._interval = cricketInterval;
                break;
            }
        }

        return { gain, nodes, active: false };
    }

    // ── TOGGLE & VOLUME ──
    function toggleSound(type) {
        ensureAudioCtx();
        const cfg = SOUNDS[type];
        const channel = document.querySelector(`.ambient-channel[data-sound="${type}"]`);
        const slider = document.getElementById(cfg.vol);

        if (channels[type] && channels[type].active) {
            // Stop
            channels[type].active = false;
            const ch = channels[type];
            ch.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
            setTimeout(() => {
                ch.nodes.forEach(n => { try { n.stop(); } catch (e) { } });
                if (ch.nodes._interval) clearInterval(ch.nodes._interval);
                ch.gain.disconnect();
            }, 400);
            delete channels[type];
            channel.classList.remove('active');
        } else {
            // Start
            const ch = createSound(type);
            ch.active = true;
            channels[type] = ch;
            const vol = (slider.value / 100) * (masterGain.gain.value);
            ch.gain.gain.setValueAtTime(0, audioCtx.currentTime);
            ch.gain.gain.linearRampToValueAtTime(vol * 0.5, audioCtx.currentTime + 0.5);
            channel.classList.add('active');
        }
        updateActivePreset();
    }

    function setVolume(type, value) {
        if (!channels[type] || !channels[type].active) return;
        const vol = (value / 100) * 0.5;
        channels[type].gain.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.1);
    }

    function setMasterVolume(value) {
        if (!masterGain) return;
        masterGain.gain.linearRampToValueAtTime(value / 100, audioCtx.currentTime + 0.1);
        document.getElementById('ambientMasterPct').textContent = value + '%';
    }

    function stopAll() {
        Object.keys(channels).forEach(type => {
            if (channels[type] && channels[type].active) {
                toggleSound(type);
            }
        });
        document.querySelectorAll('.ambient-preset-btn').forEach(b => b.classList.remove('active'));
        activePreset = null;
    }

    function applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;

        if (name === 'off') {
            stopAll();
            return;
        }

        ensureAudioCtx();

        // Stop all first
        Object.keys(channels).forEach(type => {
            if (channels[type] && channels[type].active) {
                channels[type].active = false;
                const ch = channels[type];
                ch.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.2);
                setTimeout(() => {
                    ch.nodes.forEach(n => { try { n.stop(); } catch (e) { } });
                    if (ch.nodes._interval) clearInterval(ch.nodes._interval);
                    ch.gain.disconnect();
                }, 300);
                delete channels[type];
                document.querySelector(`.ambient-channel[data-sound="${type}"]`)?.classList.remove('active');
            }
        });

        // Start preset sounds
        setTimeout(() => {
            Object.entries(preset).forEach(([type, vol]) => {
                const slider = document.getElementById(SOUNDS[type]?.vol);
                if (slider) slider.value = vol;

                if (vol > 0) {
                    const ch = createSound(type);
                    ch.active = true;
                    channels[type] = ch;
                    const v = (vol / 100) * 0.5;
                    ch.gain.gain.setValueAtTime(0, audioCtx.currentTime);
                    ch.gain.gain.linearRampToValueAtTime(v, audioCtx.currentTime + 0.8);
                    document.querySelector(`.ambient-channel[data-sound="${type}"]`)?.classList.add('active');
                }
            });
        }, 350);

        // Update preset buttons
        document.querySelectorAll('.ambient-preset-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.preset === name);
        });
        activePreset = name;
    }

    function updateActivePreset() {
        // Check if current state matches any preset
        document.querySelectorAll('.ambient-preset-btn').forEach(b => b.classList.remove('active'));
        activePreset = null;
    }

    function init() {
        // Toggle buttons
        Object.entries(SOUNDS).forEach(([type, cfg]) => {
            const toggleBtn = document.getElementById(cfg.toggle);
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => toggleSound(type));
            }

            const slider = document.getElementById(cfg.vol);
            if (slider) {
                slider.addEventListener('input', () => setVolume(type, slider.value));
            }
        });

        // Master volume
        const masterSlider = document.getElementById('ambientMasterVol');
        if (masterSlider) {
            masterSlider.addEventListener('input', () => setMasterVolume(masterSlider.value));
        }

        // Preset buttons
        document.querySelectorAll('.ambient-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
        });

        // Minimize toggle
        document.getElementById('ambientMinimize')?.addEventListener('click', () => {
            const btn = document.getElementById('ambientMinimize');
            const content = document.getElementById('ambientContent');
            btn.classList.toggle('collapsed');
            content.classList.toggle('collapsed');
        });
    }

    // 🔇 Suspend/Resume AudioContext (pause/resume tất cả ambient sounds)
    function suspendAudio() {
        if (audioCtx && audioCtx.state === 'running') {
            audioCtx.suspend();
            console.log('🔇 Ambient sounds suspended');
        }
    }

    function resumeAudio() {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
            console.log('🔊 Ambient sounds resumed');
        }
    }

    return { init, applyPreset, toggleSound, setMasterVolume, suspendAudio, resumeAudio, getActiveChannels: () => Object.keys(channels).filter(k => channels[k]?.active) };
})();

// Initialize Ambient Mixer
document.addEventListener('DOMContentLoaded', () => {
    AmbientMixer.init();
});

// ============================================================
// 📅 DAILY FOCUS TRACKER
// ============================================================
const DailyFocusTracker = (() => {
    const DAY_NAMES_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    function toDateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem('habitflow_focus_history') || '[]');
        } catch (e) { return []; }
    }

    function aggregateByDate() {
        const history = getHistory();
        const map = {}; // { 'YYYY-MM-DD': { sessions, totalSec, xp, points } }
        history.forEach(h => {
            const d = new Date(h.date);
            const key = toDateKey(d);
            if (!map[key]) map[key] = { sessions: 0, totalSec: 0, xp: 0, points: 0 };
            map[key].sessions++;
            map[key].totalSec += (h.duration || 0);
            map[key].points += (h.points || 0);
            // Estimate XP same as award logic
            const baseXP = h.points || 0;
            const bonusXP = Math.max(0, Math.floor(((h.duration || 0) - 25 * 60) / (10 * 60)) * 5);
            map[key].xp += baseXP + bonusXP;
        });
        return map;
    }
    let viewYear, viewMonth;
    const MONTH_NAMES = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
        'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
    const MONTH_SHORT = ['Th1', 'Th2', 'Th3', 'Th4', 'Th5', 'Th6',
        'Th7', 'Th8', 'Th9', 'Th10', 'Th11', 'Th12'];

    function init() {
        const now = new Date();
        viewYear = now.getFullYear();
        viewMonth = now.getMonth();

        // Month nav
        document.getElementById('focusContribPrev')?.addEventListener('click', () => {
            viewMonth--;
            if (viewMonth < 0) { viewMonth = 11; viewYear--; }
            const data = aggregateByDate();
            renderMonthlyGraph(data);
        });
        document.getElementById('focusContribNext')?.addEventListener('click', () => {
            viewMonth++;
            if (viewMonth > 11) { viewMonth = 0; viewYear++; }
            const data = aggregateByDate();
            renderMonthlyGraph(data);
        });

        render();
    }

    function render() {
        const data = aggregateByDate();
        renderTodaySummary(data);
        renderMonthlyGraph(data);
        renderWeeklyChart(data);
        renderYearlyGraph(data);
    }

    function renderTodaySummary(data) {
        const today = new Date();
        const key = toDateKey(today);
        const d = data[key] || { sessions: 0, totalSec: 0, xp: 0, points: 0 };

        document.getElementById('dailyTodayDate').textContent =
            `${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}`;

        document.getElementById('dailyTodaySessions').textContent = d.sessions;

        const mins = Math.round(d.totalSec / 60);
        document.getElementById('dailyTodayTime').textContent =
            mins >= 60 ? (mins / 60).toFixed(1) + 'h' : mins + 'm';

        document.getElementById('dailyTodayXP').textContent = d.xp;
        document.getElementById('dailyTodayPoints').textContent = d.points;
    }

    function getCellLevel(mins) {
        if (mins >= 90) return 'lv4';
        if (mins >= 45) return 'lv3';
        if (mins >= 15) return 'lv2';
        if (mins > 0) return 'lv1';
        return '';
    }

    function buildCellHtml(cursor, data, todayKey) {
        const key = toDateKey(cursor);
        const rec = data[key];
        const mins = rec ? Math.round(rec.totalSec / 60) : 0;
        const sessions = rec ? rec.sessions : 0;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const isFuture = cursor > today;
        const isToday = key === todayKey;

        let lvClass = '';
        if (!isFuture) lvClass = getCellLevel(mins);

        const dateStr = `${cursor.getDate()}/${cursor.getMonth() + 1}/${cursor.getFullYear()}`;
        let tipText;
        if (isFuture) tipText = dateStr;
        else if (mins > 0) tipText = `<strong>${sessions} phiên</strong> • ${mins} phút<br>${dateStr}`;
        else tipText = `Không tập trung<br>${dateStr}`;

        return { html: `<div class="contrib-cell ${lvClass} ${isToday ? 'today' : ''} ${isFuture ? 'future' : ''}" data-date="${key}"><div class="contrib-tip">${tipText}</div></div>`, sessions: isFuture ? 0 : sessions, mins };
    }

    // ── MONTHLY GRAPH (Focus page) ──
    function renderMonthlyGraph(data) {
        const grid = document.getElementById('contribGrid');
        const monthLabels = document.getElementById('contribMonthLabels');
        const totalEl = document.getElementById('contribTotal');
        const labelEl = document.getElementById('focusContribMonthLabel');
        const statsEl = document.getElementById('contribMonthStats');
        if (!grid) return;

        labelEl.textContent = `${MONTH_NAMES[viewMonth]}, ${viewYear}`;

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const todayKey = toDateKey(today);

        // First day & last day of month
        const firstOfMonth = new Date(viewYear, viewMonth, 1);
        const lastOfMonth = new Date(viewYear, viewMonth + 1, 0);

        // Start from Sunday of the first week
        const startDate = new Date(firstOfMonth);
        startDate.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());

        // End at Saturday of the last week
        const endDate = new Date(lastOfMonth);
        endDate.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

        let weeksHtml = '';
        let totalSessions = 0;
        let totalMins = 0;
        let weekIdx = 0;
        const cursor = new Date(startDate);

        // Count total weeks first for percentage positioning
        const totalWeeks = Math.ceil((endDate - startDate + 1) / (7 * 86400000));

        // Week labels
        let weekLabelsHtml = '';

        while (cursor <= endDate) {
            let weekHtml = '';
            const weekStart = new Date(cursor);

            for (let dow = 0; dow < 7; dow++) {
                const result = buildCellHtml(cursor, data, todayKey);
                weekHtml += result.html;
                if (cursor.getMonth() === viewMonth && cursor.getFullYear() === viewYear) {
                    totalSessions += result.sessions;
                    totalMins += result.mins;
                }
                cursor.setDate(cursor.getDate() + 1);
            }

            const label = `${weekStart.getDate()}`;
            const cellSize = 15; // 11px cell + 4px gap
            weekLabelsHtml += `<span class="contrib-month-label" style="left:${weekIdx * cellSize}px">${label}</span>`;

            weeksHtml += `<div class="contrib-week">${weekHtml}</div>`;
            weekIdx++;
        }

        grid.innerHTML = weeksHtml;
        monthLabels.innerHTML = weekLabelsHtml;
        totalEl.textContent = `${totalSessions} phiên`;

        const timeStr = totalMins >= 60 ? (totalMins / 60).toFixed(1) + ' giờ' : totalMins + ' phút';
        statsEl.textContent = `Tổng: ${timeStr} tập trung`;
    }

    // ── YEARLY GRAPH (Dashboard) ──
    function renderYearlyGraph(data) {
        const grid = document.getElementById('dashContribGrid');
        const monthLabels = document.getElementById('dashContribMonthLabels');
        const totalEl = document.getElementById('dashContribTotal');
        if (!grid) return;

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const todayKey = toDateKey(today);

        // Go back 52 weeks
        const endOfWeek = new Date(today);
        endOfWeek.setDate(today.getDate() + (6 - today.getDay()));
        const startDate = new Date(endOfWeek);
        startDate.setDate(endOfWeek.getDate() - (52 * 7) + 1);
        startDate.setDate(startDate.getDate() - startDate.getDay());

        let weeksHtml = '';
        let monthsHtml = '';
        let totalSessions = 0;
        let lastMonth = -1;
        let weekIdx = 0;
        const cursor = new Date(startDate);
        const cellSize = 15; // 11px cell + 4px gap

        while (cursor <= endOfWeek) {
            let weekHtml = '';
            for (let dow = 0; dow < 7; dow++) {
                // Month label on first Sunday of new month
                if (dow === 0 && cursor.getMonth() !== lastMonth) {
                    lastMonth = cursor.getMonth();
                    monthsHtml += `<span class="contrib-month-label" style="left:${weekIdx * cellSize}px">${MONTH_SHORT[lastMonth]}</span>`;
                }
                const result = buildCellHtml(cursor, data, todayKey);
                weekHtml += result.html;
                totalSessions += result.sessions;
                cursor.setDate(cursor.getDate() + 1);
            }
            weeksHtml += `<div class="contrib-week">${weekHtml}</div>`;
            weekIdx++;
        }

        grid.innerHTML = weeksHtml;
        monthLabels.innerHTML = monthsHtml;
        totalEl.textContent = `${totalSessions} phiên trong năm qua`;
    }

    function renderWeeklyChart(data) {
        const chart = document.getElementById('dailyWeeklyChart');
        const today = new Date();
        const dayOfWeek = today.getDay();

        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - dayOfWeek);

        let maxMin = 1;
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(startOfWeek);
            d.setDate(startOfWeek.getDate() + i);
            const key = toDateKey(d);
            const rec = data[key];
            const mins = rec ? Math.round(rec.totalSec / 60) : 0;
            if (mins > maxMin) maxMin = mins;
            days.push({ label: DAY_NAMES_SHORT[i], mins, isToday: toDateKey(d) === toDateKey(today) });
        }

        chart.innerHTML = days.map(d => {
            const pct = d.mins > 0 ? Math.max(5, (d.mins / maxMin) * 100) : 0;
            const timeStr = d.mins >= 60 ? (d.mins / 60).toFixed(1) + 'h' : d.mins + 'm';
            return `
                <div class="daily-week-bar-wrap ${d.isToday ? 'today' : ''}">
                    <div class="daily-week-val">${d.mins > 0 ? timeStr : ''}</div>
                    <div class="daily-week-bar">
                        <div class="daily-week-fill" style="height: ${pct}%"></div>
                    </div>
                    <div class="daily-week-label">${d.label}</div>
                </div>`;
        }).join('');
    }

    return { init, render };
})();

document.addEventListener('DOMContentLoaded', () => {
    DailyFocusTracker.init();
});

// ============================================================
// ⭐ FOCUS XP SYSTEM
// ============================================================
const FocusXP = (() => {
    const STORAGE_KEY = 'habitflow_focus_xp';

    // XP required = 100 * level (Level 1: 100, Level 2: 200, etc.)
    function xpForLevel(level) {
        return 100 * level;
    }

    // State
    let state = {
        level: 1,
        currentXP: 0,
        totalXP: 0,
        totalPoints: 0,
        totalSessions: 0,
        totalTimeSec: 0,
    };

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (saved) Object.assign(state, saved);
        } catch (e) { }
    }

    function save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function addXP(amount, pointsEarned, durationSec) {
        state.totalXP += amount;
        state.totalPoints += pointsEarned;
        state.totalSessions++;
        state.totalTimeSec += durationSec;
        state.currentXP += amount;

        let didLevelUp = false;

        // Check level up (possibly multiple)
        while (state.currentXP >= xpForLevel(state.level)) {
            state.currentXP -= xpForLevel(state.level);
            state.level++;
            didLevelUp = true;
        }

        save();
        updateUI();

        // Show XP gain popup
        showXPGain(amount, didLevelUp);

        if (didLevelUp) {
            // Level up animation
            const badge = document.getElementById('xpLevelBadge');
            if (badge) {
                badge.classList.add('level-up');
                setTimeout(() => badge.classList.remove('level-up'), 1000);
            }
            showToast(`🎉 Level Up! Bạn đã đạt Level ${state.level}!`, 'success');
        }

        return { didLevelUp, newLevel: state.level };
    }

    function showXPGain(amount, levelUp) {
        const popup = document.getElementById('xpGainPopup');
        const amountEl = document.getElementById('xpGainAmount');
        if (!popup || !amountEl) return;

        amountEl.textContent = `+${amount} XP${levelUp ? ' 🎉 LEVEL UP!' : ''}`;
        popup.classList.remove('show');
        // Force reflow
        void popup.offsetWidth;
        popup.classList.add('show');

        setTimeout(() => popup.classList.remove('show'), 2500);
    }

    function updateUI() {
        const needed = xpForLevel(state.level);
        const pct = Math.min((state.currentXP / needed) * 100, 100);

        // Level
        const levelNum = document.getElementById('xpLevelNum');
        if (levelNum) levelNum.textContent = state.level;

        // XP Progress
        const current = document.getElementById('xpCurrent');
        const neededEl = document.getElementById('xpNeeded');
        const fill = document.getElementById('xpProgressFill');
        if (current) current.textContent = state.currentXP;
        if (neededEl) neededEl.textContent = needed;
        if (fill) fill.style.width = pct + '%';

        // Stats
        const totalPts = document.getElementById('xpTotalPoints');
        if (totalPts) totalPts.textContent = state.totalPoints;

        const totalSes = document.getElementById('xpTotalSessions');
        if (totalSes) totalSes.textContent = state.totalSessions;

        const totalTime = document.getElementById('xpTotalTime');
        if (totalTime) {
            const hours = state.totalTimeSec / 3600;
            totalTime.textContent = hours < 1
                ? Math.round(state.totalTimeSec / 60) + 'm'
                : hours.toFixed(1) + 'h';
        }

        // Also update spin wheel modal XP display
        const spinXP = document.getElementById('spinXPGained');
        if (spinXP) spinXP.textContent = `LVL ${state.level} • ${state.currentXP}/${needed} XP`;
    }

    function getState() {
        return { ...state };
    }

    // ── GOOGLE SHEETS SYNC ──
    async function syncToServer() {
        if (!API_URL) return;
        try {
            const history = JSON.parse(localStorage.getItem('habitflow_focus_history') || '[]');
            await apiPost({
                action: 'syncFocusData',
                history: history,
                xpState: state
            });
            console.log('✅ Focus data synced to server');
        } catch (e) {
            console.log('⚠️ Focus sync failed:', e.message);
        }
    }

    async function syncSession(session) {
        if (!API_URL) return;
        try {
            await apiPost({
                action: 'saveFocusSession',
                session: session
            });
            await apiPost({
                action: 'saveFocusXP',
                xpState: state
            });
        } catch (e) {
            console.log('⚠️ Focus session sync failed:', e.message);
        }
    }

    // Normalize date from various formats (Google Sheets Date obj, ISO, etc.)
    function normalizeDate(dateVal) {
        if (!dateVal) return '';
        const str = String(dateVal);
        // Already in YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        // ISO string: "2026-03-02T00:00:00.000Z"
        if (str.includes('T')) return str.split('T')[0];
        // Try parsing as Date
        try {
            const d = new Date(str);
            if (!isNaN(d.getTime())) {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            }
        } catch { }
        return str;
    }

    function mergeFocusData(focusHistory, focusXP) {
        // Merge XP: server wins if >= local OR local has no sessions but server does
        if (focusXP) {
            const serverXP = Number(focusXP.totalXP) || 0;
            const serverSessions = Number(focusXP.totalSessions) || 0;
            const shouldUpdate = serverXP >= state.totalXP ||
                (state.totalSessions === 0 && serverSessions > 0);

            if (shouldUpdate) {
                state.level = Number(focusXP.level) || 1;
                state.currentXP = Number(focusXP.currentXP) || 0;
                state.totalXP = Number(focusXP.totalXP) || 0;
                state.totalPoints = Number(focusXP.totalPoints) || 0;
                state.totalSessions = Number(focusXP.totalSessions) || 0;
                state.totalTimeSec = Number(focusXP.totalTimeSec) || 0;
                save();
                updateUI();
                console.log('✅ XP state updated from server');
            }
        }

        // Merge focus history: combine & dedup by ID, normalize dates
        if (focusHistory && focusHistory.length > 0) {
            const local = JSON.parse(localStorage.getItem('habitflow_focus_history') || '[]');
            const merged = [...local];
            const localIds = new Set(local.map(h => h.id));

            let addedCount = 0;
            focusHistory.forEach(serverEntry => {
                const id = String(serverEntry.id);
                if (!localIds.has(id)) {
                    const dateVal = normalizeDate(serverEntry.date || serverEntry.createdAt);
                    merged.push({
                        id: id,
                        mode: String(serverEntry.mode || 'deepwork'),
                        duration: Number(serverEntry.duration) || 0,
                        points: Number(serverEntry.points) || 0,
                        date: dateVal,
                        reward: serverEntry.reward || null
                    });
                    localIds.add(id);
                    addedCount++;
                }
            });

            if (addedCount > 0) {
                // Sort by date desc
                merged.sort((a, b) => new Date(b.date) - new Date(a.date));
                localStorage.setItem('habitflow_focus_history', JSON.stringify(merged));
                console.log(`✅ Added ${addedCount} focus sessions from server`);

                // Refresh daily tracker & history
                if (typeof DailyFocusTracker !== 'undefined') DailyFocusTracker.render();
                if (typeof renderFocusHistory === 'function') renderFocusHistory();
            }
        }
    }

    async function loadFromServer() {
        if (!API_URL) return;
        try {
            const res = await apiGet({ action: 'getFocusData' });
            if (!res.success) return;
            mergeFocusData(res.focusHistory, res.focusXP);
            console.log('✅ Focus data loaded from server');
        } catch (e) {
            console.log('⚠️ Focus load from server failed:', e.message);
        }
    }

    // Called by main loadAll() with data from getAll response
    function mergeFocusFromAPI(focusHistory, focusXP) {
        mergeFocusData(focusHistory, focusXP);
    }

    function init() {
        load();
        updateUI();
        // Load from server after a short delay (non-blocking)
        setTimeout(() => loadFromServer(), 2000);
    }

    return { init, addXP, updateUI, getState, syncToServer, syncSession, loadFromServer, mergeFocusFromAPI };
})();

document.addEventListener('DOMContentLoaded', () => {
    FocusXP.init();
});

// ============================================================
// ⚡ FLOATING FOCUS MENU
// ============================================================
const FocusFloatMenu = (() => {
    let isOpen = false;

    function init() {
        const toggle = document.getElementById('ffmToggle');
        const items = document.getElementById('ffmItems');
        if (!toggle || !items) return;

        // Toggle expand/collapse
        toggle.addEventListener('click', () => {
            isOpen = !isOpen;
            toggle.classList.toggle('open', isOpen);
            items.classList.toggle('show', isOpen);
        });

        // Play/Pause
        const playBtn = document.getElementById('ffmPlayPause');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                document.getElementById('focusBtnStart')?.click();
                syncPlayButton();
            });
        }

        // Reset
        const resetBtn = document.getElementById('ffmReset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                document.getElementById('focusBtnReset')?.click();
                syncPlayButton();
            });
        }

        // Scroll to section
        document.querySelectorAll('.ffm-btn[data-scroll]').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = document.querySelector('.' + btn.dataset.scroll);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        // Ambient presets
        document.querySelectorAll('.ffm-ambient').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.dataset.ambient;
                if (typeof AmbientMixer !== 'undefined') {
                    AmbientMixer.applyPreset(preset);
                }
                // Update active state
                document.querySelectorAll('.ffm-ambient').forEach(b => b.classList.remove('active'));
                if (preset !== 'off') {
                    btn.classList.add('active');
                }
            });
        });

        // Periodically sync play button state
        setInterval(syncPlayButton, 500);
    }

    function syncPlayButton() {
        const mainBtn = document.getElementById('focusBtnStart');
        const ffmPlay = document.getElementById('ffmPlayPause');
        if (!mainBtn || !ffmPlay) return;

        const isRunning = mainBtn.classList.contains('running');
        ffmPlay.classList.toggle('running', isRunning);
        const icon = ffmPlay.querySelector('i');
        if (icon) {
            icon.className = isRunning ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        }
        const label = ffmPlay.querySelector('span');
        if (label) {
            label.textContent = isRunning ? 'Tạm dừng' : 'Bắt đầu';
        }
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
    FocusFloatMenu.init();
    FocusFullscreen.init();
});

// ============================================================
// 🖥️ FULLSCREEN FOCUS MODE
// ============================================================
const FocusFullscreen = (() => {
    const FS_CIRCUMFERENCE = 2 * Math.PI * 140; // ~879.65
    let particleCtx = null;
    let particles = [];
    let animFrame = null;
    let isActive = false;

    // Auto-play settings
    const LS_AUTOPLAY = 'habitflow_fs_autoplay'; // 'none' | 'music' | 'ambient'
    const LS_AUTOPLAY_PRESET = 'habitflow_fs_autoplay_preset';

    const QUOTES = [
        '"The secret of getting ahead is getting started." — Mark Twain',
        '"Focus on being productive instead of busy." — Tim Ferriss',
        '"It is not enough to be busy, the question is: what are we busy about?" — Henry David Thoreau',
        '"Do the hard jobs first. The easy jobs will take care of themselves." — Dale Carnegie',
        '"Concentrate all your thoughts upon the work at hand." — Alexander Graham Bell',
        '"The way to get started is to quit talking and begin doing." — Walt Disney',
        '"Chất lượng không bao giờ là ngẫu nhiên, nó luôn là kết quả của nỗ lực." — John Ruskin',
        '"Sự tập trung là chìa khóa của thành công." — Unknown',
        '"Start where you are. Use what you have. Do what you can." — Arthur Ashe',
        '"Your limitation—it\'s only your imagination."',
    ];

    function init() {
        // Exit button
        document.getElementById('fsExit')?.addEventListener('click', exit);

        // ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isActive) exit();
        });

        // Play/Pause
        document.getElementById('fsPlayBtn')?.addEventListener('click', () => {
            document.getElementById('focusBtnStart')?.click();
            setTimeout(() => syncPlayState(), 100);
        });

        // Reset
        document.getElementById('fsResetBtn')?.addEventListener('click', () => {
            document.getElementById('focusBtnReset')?.click();
            exit();
        });

        // Skip
        document.getElementById('fsSkipBtn')?.addEventListener('click', () => {
            exit();
        });

        // ── SIDE PANEL TOGGLES ──
        document.getElementById('fsMusicToggle')?.addEventListener('click', () => {
            const panel = document.getElementById('fsMusicPanel');
            const btn = document.getElementById('fsMusicToggle');
            panel.classList.toggle('open');
            btn.classList.toggle('active');
            if (panel.classList.contains('open')) renderFsPlaylist();
        });

        document.getElementById('fsAmbientToggle')?.addEventListener('click', () => {
            const panel = document.getElementById('fsAmbientPanel');
            const btn = document.getElementById('fsAmbientToggle');
            panel.classList.toggle('open');
            btn.classList.toggle('active');
            if (panel.classList.contains('open')) renderFsAmbientState();
        });

        // ── FS AMBIENT SOUND TOGGLES ──
        document.querySelectorAll('.fs-amb-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sound = btn.dataset.fsSound;
                if (typeof AmbientMixer !== 'undefined') {
                    AmbientMixer.toggleSound(sound);
                    // Also sync main page toggle
                    const mainChannel = document.querySelector(`.ambient-channel[data-sound="${sound}"]`);
                    if (mainChannel) mainChannel.classList.toggle('active');
                }
                btn.classList.toggle('active');
            });
        });

        // ── FS AMBIENT PRESETS ──
        document.querySelectorAll('.fs-amb-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.dataset.fsPreset;
                if (typeof AmbientMixer !== 'undefined') {
                    AmbientMixer.applyPreset(preset);
                }
                document.querySelectorAll('.fs-amb-preset').forEach(b => b.classList.remove('active'));
                if (preset !== 'off') btn.classList.add('active');
                // Sync ambient button states after delay
                setTimeout(() => renderFsAmbientState(), 500);
            });
        });

        // ── FS AMBIENT VOLUME ──
        const fsVol = document.getElementById('fsAmbientVol');
        if (fsVol) {
            fsVol.addEventListener('input', () => {
                const val = fsVol.value;
                document.getElementById('fsAmbientVolPct').textContent = val + '%';
                if (typeof AmbientMixer !== 'undefined') {
                    AmbientMixer.setMasterVolume(val);
                    // Sync main page master vol
                    const mainVol = document.getElementById('ambientMasterVol');
                    if (mainVol) mainVol.value = val;
                    const mainPct = document.getElementById('ambientMasterPct');
                    if (mainPct) mainPct.textContent = val + '%';
                }
            });
        }

        // Periodic sync every 2s
        setInterval(() => {
            if (!isActive) return;
            syncNowPlaying();
        }, 2000);

        // ── FULLSCREEN AUTO-PLAY SETTINGS ──
        const savedAutoplay = localStorage.getItem(LS_AUTOPLAY) || 'none';
        const savedPreset = localStorage.getItem(LS_AUTOPLAY_PRESET) || 'rainforest';

        // Restore saved state
        const radioEl = document.querySelector(`input[name="fsAutoplay"][value="${savedAutoplay}"]`);
        if (radioEl) radioEl.checked = true;

        const presetSelect = document.getElementById('fsAutoPresetSelect');
        if (presetSelect) presetSelect.value = savedPreset;

        const presetWrap = document.getElementById('fsAutoPresetWrap');
        if (presetWrap) presetWrap.style.display = savedAutoplay === 'ambient' ? 'block' : 'none';

        // Radio change
        document.querySelectorAll('input[name="fsAutoplay"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const val = radio.value;
                localStorage.setItem(LS_AUTOPLAY, val);
                const pw = document.getElementById('fsAutoPresetWrap');
                if (pw) pw.style.display = val === 'ambient' ? 'block' : 'none';
            });
        });

        // Preset change
        if (presetSelect) {
            presetSelect.addEventListener('change', () => {
                localStorage.setItem(LS_AUTOPLAY_PRESET, presetSelect.value);
            });
        }
    }

    function enter(mode, config, timeLeft, totalTime) {
        isActive = true;
        const el = document.getElementById('focusFullscreen');
        el.classList.add('active');
        document.body.style.overflow = 'hidden';

        // Set mode label
        const label = document.getElementById('fsModeLabel');
        label.querySelector('span').textContent = config.label;

        // Set quote
        document.getElementById('fsQuote').textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];

        // Sync timer
        syncTimer(timeLeft, totalTime, true);
        syncPlayState();

        // Sync now playing music
        syncNowPlaying();

        // Init particles
        initParticles();

        // Render dots
        renderFsDots();

        // Render side panels content
        renderFsPlaylist();
        renderFsAmbientState();

        // ── AUTO-PLAY on enter ──
        const autoSetting = localStorage.getItem(LS_AUTOPLAY) || 'none';
        if (autoSetting === 'music') {
            // Auto-play first track in playlist
            if (typeof FocusMusic !== 'undefined') {
                const playlist = FocusMusic.getPlaylist();
                const currentId = FocusMusic.getCurrentTrackId();
                if (!currentId && playlist.length > 0) {
                    FocusMusic.play(playlist[0].id);
                    setTimeout(() => { syncNowPlaying(); renderFsPlaylist(); }, 500);
                }
            }
        } else if (autoSetting === 'ambient') {
            // Auto-apply favorite preset
            if (typeof AmbientMixer !== 'undefined') {
                const preset = localStorage.getItem(LS_AUTOPLAY_PRESET) || 'rainforest';
                AmbientMixer.applyPreset(preset);
                setTimeout(() => renderFsAmbientState(), 500);
            }
        }
    }

    function exit() {
        isActive = false;
        const el = document.getElementById('focusFullscreen');
        el.classList.remove('active');
        document.body.style.overflow = '';
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = null;

        // Close side panels
        document.getElementById('fsMusicPanel')?.classList.remove('open');
        document.getElementById('fsAmbientPanel')?.classList.remove('open');
        document.getElementById('fsMusicToggle')?.classList.remove('active');
        document.getElementById('fsAmbientToggle')?.classList.remove('active');
    }

    function syncTimer(timeLeft, totalTime, running) {
        if (!isActive) return;

        // Update time display
        const min = Math.floor(timeLeft / 60);
        const sec = timeLeft % 60;
        const el = document.getElementById('fsTimeDisplay');
        if (el) el.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

        // Update ring
        const fraction = totalTime > 0 ? timeLeft / totalTime : 1;
        const offset = FS_CIRCUMFERENCE * (1 - fraction);
        const progress = document.getElementById('fsTimerProgress');
        const glow = document.getElementById('fsTimerGlow');
        if (progress) progress.style.strokeDashoffset = offset;
        if (glow) glow.style.strokeDashoffset = offset;

        // Update subtitle
        const sub = document.getElementById('fsSubtitle');
        if (sub) {
            if (timeLeft > 0) {
                sub.textContent = running ? 'Stay focused' : 'Paused';
            } else {
                sub.textContent = 'Complete!';
            }
        }
    }

    function syncPlayState() {
        const mainBtn = document.getElementById('focusBtnStart');
        const fsBtn = document.getElementById('fsPlayBtn');
        if (!mainBtn || !fsBtn) return;

        const running = mainBtn.classList.contains('running');
        fsBtn.querySelector('i').className = running ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        fsBtn.classList.toggle('paused', !running);
    }

    function syncNowPlaying() {
        const musicNP = document.getElementById('musicNowPlaying');
        const fsNP = document.getElementById('fsNowPlaying');
        const fsText = document.getElementById('fsNowPlayingText');
        if (!musicNP || !fsNP || !fsText) return;

        if (musicNP.style.display !== 'none') {
            fsNP.style.display = 'flex';
            fsText.textContent = document.getElementById('musicNowPlayingName')?.textContent || 'Đang phát nhạc...';
        } else {
            fsNP.style.display = 'none';
        }
    }

    function renderFsDots() {
        const container = document.getElementById('fsDots');
        if (!container) return;
        // Simple session dots: get from main timer sessions done
        const sessionEl = document.getElementById('focusSessionsDone');
        const goalEl = document.getElementById('focusSessionsGoal');
        const done = parseInt(sessionEl?.textContent || '0');
        const goal = parseInt(goalEl?.textContent || '4');

        let html = '';
        for (let i = 0; i < goal; i++) {
            if (i < done) {
                html += '<div class="focus-fs-dot done"></div>';
            } else if (i === done) {
                html += '<div class="focus-fs-dot current"></div>';
            } else {
                html += '<div class="focus-fs-dot"></div>';
            }
        }
        container.innerHTML = html;
    }

    // ── PARTICLES ──
    function initParticles() {
        const canvas = document.getElementById('focusParticles');
        if (!canvas) return;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        particleCtx = canvas.getContext('2d');

        particles = [];
        const count = 60;
        for (let i = 0; i < count; i++) {
            particles.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: Math.random() * 2 + 0.5,
                dx: (Math.random() - 0.5) * 0.3,
                dy: (Math.random() - 0.5) * 0.2,
                opacity: Math.random() * 0.3 + 0.05,
                color: ['#06b6d4', '#8b5cf6', '#10b981', '#f59e0b'][Math.floor(Math.random() * 4)],
            });
        }

        animateParticles();

        window.addEventListener('resize', () => {
            if (!isActive) return;
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    }

    function animateParticles() {
        if (!isActive || !particleCtx) return;
        const canvas = particleCtx.canvas;
        particleCtx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach(p => {
            p.x += p.dx;
            p.y += p.dy;

            if (p.x < 0) p.x = canvas.width;
            if (p.x > canvas.width) p.x = 0;
            if (p.y < 0) p.y = canvas.height;
            if (p.y > canvas.height) p.y = 0;

            particleCtx.beginPath();
            particleCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            particleCtx.fillStyle = p.color;
            particleCtx.globalAlpha = p.opacity;
            particleCtx.fill();
        });

        particleCtx.globalAlpha = 1;
        animFrame = requestAnimationFrame(animateParticles);
    }

    // ── FS PLAYLIST RENDER ──
    function renderFsPlaylist() {
        const container = document.getElementById('fsPlaylist');
        if (!container || typeof FocusMusic === 'undefined') return;

        const playlist = FocusMusic.getPlaylist();
        const currentId = FocusMusic.getCurrentTrackId();

        if (playlist.length === 0) {
            container.innerHTML = '<div class="fs-playlist-empty">Chưa có bài nhạc nào.<br>Thêm nhạc ở trang chính.</div>';
            return;
        }

        container.innerHTML = playlist.map(track => `
            <div class="fs-track ${track.id === currentId ? 'playing' : ''}" onclick="FocusMusic.play('${track.id}'); setTimeout(() => document.getElementById('fsMusicPanel')?.classList.contains('open') && FocusFullscreen.renderPlaylist(), 200);">
                <div class="fs-track-icon">
                    <i class="fa-solid ${track.id === currentId ? 'fa-pause' : 'fa-play'}"></i>
                </div>
                <div class="fs-track-name">${track.name}</div>
            </div>
        `).join('');
    }

    // ── FS AMBIENT STATE SYNC ──
    function renderFsAmbientState() {
        if (typeof AmbientMixer === 'undefined') return;
        const activeChannels = AmbientMixer.getActiveChannels();

        document.querySelectorAll('.fs-amb-btn').forEach(btn => {
            const sound = btn.dataset.fsSound;
            btn.classList.toggle('active', activeChannels.includes(sound));
        });
    }

    return { init, enter, exit, syncTimer, renderPlaylist: renderFsPlaylist };
})();
