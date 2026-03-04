// ============================================================
// HABIT TRACKER - Google Apps Script API
// File: Code.gs
// Dán toàn bộ code này vào Google Apps Script Editor
// ============================================================

// ⚙️ CẤU HÌNH - Thay đổi SPREADSHEET_ID của bạn vào đây
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

// Tên các sheet
const SHEET_HABITS = 'Habits';
const SHEET_COMPLETIONS = 'Completions';
const SHEET_SETTINGS = 'Settings';
const SHEET_JOURNAL = 'Journal';
const SHEET_FOCUS_HISTORY = 'FocusHistory';
const SHEET_FOCUS_XP = 'FocusXP';
const SHEET_PLAYLIST = 'Playlist';

// ============================================================
// CORS Headers helper
// ============================================================
function setCORSHeaders(output) {
  return output
    .setMimeType(ContentService.MimeType.JSON);
}

function responseJSON(data) {
  return setCORSHeaders(
    ContentService.createTextOutput(JSON.stringify(data))
  );
}

// ============================================================
// doGet - Xử lý GET requests
// ============================================================
function doGet(e) {
  try {
    const action = e.parameter.action || 'getAll';
    
    switch (action) {
      case 'getHabits':
        return responseJSON(getHabits());
      
      case 'getCompletions':
        const year = e.parameter.year || new Date().getFullYear();
        const month = e.parameter.month || (new Date().getMonth() + 1);
        return responseJSON(getCompletions(year, month));
      
      case 'getStats':
        return responseJSON(getStats());
      
      case 'getFocusData':
        return responseJSON(getFocusData());
      
      case 'getLatestUrl':
        return responseJSON(getLatestDeploymentUrl());
      
      case 'getPlaylist':
        return responseJSON(getPlaylist());
      
      case 'getAll':
      default:
        return responseJSON(getAllData());
    }
  } catch (error) {
    return responseJSON({ success: false, error: error.message });
  }
}

// ============================================================
// doPost - Xử lý POST requests
// ============================================================
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    
    switch (action) {
      case 'addHabit':
        return responseJSON(addHabit(body.name, body.icon, body.color, body.active));
      
      case 'deleteHabit':
        return responseJSON(deleteHabit(body.habitId));
      
      case 'toggleCompletion':
        return responseJSON(toggleCompletion(body.habitId, body.date));
      
      case 'updateHabit':
        return responseJSON(updateHabit(body.habitId, body.name, body.icon, body.color, body.active));
      
      case 'saveJournal':
        return responseJSON(saveJournal(body.date, body.mood, body.content));
      
      case 'saveFocusSession':
        return responseJSON(saveFocusSession(body.session));
      
      case 'saveFocusXP':
        return responseJSON(saveFocusXP(body.xpState));
      
      case 'syncFocusData':
        return responseJSON(syncFocusData(body.history, body.xpState));
      
      case 'registerUrl':
        return responseJSON(registerDeploymentUrl(body.url));
      
      case 'savePlaylistTrack':
        return responseJSON(savePlaylistTrack(body.track));
      
      case 'deletePlaylistTrack':
        return responseJSON(deletePlaylistTrack(body.trackId));
      
      default:
        return responseJSON({ success: false, error: 'Action không hợp lệ' });
    }
  } catch (error) {
    return responseJSON({ success: false, error: error.message });
  }
}

// ============================================================
// SETUP - Tạo cấu trúc Sheet ban đầu
// ============================================================
function setupSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // Tạo sheet Habits
  let habitsSheet = ss.getSheetByName(SHEET_HABITS);
  if (!habitsSheet) {
    habitsSheet = ss.insertSheet(SHEET_HABITS);
    habitsSheet.getRange(1, 1, 1, 6).setValues([
      ['ID', 'Name', 'Icon', 'Color', 'CreatedAt', 'Active']
    ]);
    habitsSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    habitsSheet.setFrozenRows(1);
    
    habitsSheet.appendRow([
      generateId(), 'Thiền định', '🧘', '#6366f1',
      new Date().toISOString(), true
    ]);
    habitsSheet.appendRow([
      generateId(), 'Tập thể dục', '💪', '#10b981',
      new Date().toISOString(), true
    ]);
    habitsSheet.appendRow([
      generateId(), 'Đọc sách', '📚', '#f59e0b',
      new Date().toISOString(), true
    ]);
  }
  
  // Tạo sheet Completions
  let completionsSheet = ss.getSheetByName(SHEET_COMPLETIONS);
  if (!completionsSheet) {
    completionsSheet = ss.insertSheet(SHEET_COMPLETIONS);
    completionsSheet.getRange(1, 1, 1, 3).setValues([
      ['HabitID', 'Date', 'CompletedAt']
    ]);
    completionsSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    completionsSheet.setFrozenRows(1);
  }

  // Tạo sheet Journal
  let journalSheet = ss.getSheetByName(SHEET_JOURNAL);
  if (!journalSheet) {
    journalSheet = ss.insertSheet(SHEET_JOURNAL);
    journalSheet.getRange(1, 1, 1, 4).setValues([
      ['Date', 'Mood', 'Content', 'UpdatedAt']
    ]);
    journalSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    journalSheet.setFrozenRows(1);
  }

  // Tạo sheet FocusHistory
  let focusHistSheet = ss.getSheetByName(SHEET_FOCUS_HISTORY);
  if (!focusHistSheet) {
    focusHistSheet = ss.insertSheet(SHEET_FOCUS_HISTORY);
    focusHistSheet.getRange(1, 1, 1, 7).setValues([
      ['ID', 'Date', 'Mode', 'Duration', 'Points', 'Reward', 'CreatedAt']
    ]);
    focusHistSheet.getRange(1, 1, 1, 7).setFontWeight('bold');
    focusHistSheet.setFrozenRows(1);
  }

  // Tạo sheet FocusXP
  let focusXPSheet = ss.getSheetByName(SHEET_FOCUS_XP);
  if (!focusXPSheet) {
    focusXPSheet = ss.insertSheet(SHEET_FOCUS_XP);
    focusXPSheet.getRange(1, 1, 1, 6).setValues([
      ['Level', 'CurrentXP', 'TotalXP', 'TotalPoints', 'TotalSessions', 'TotalTimeSec']
    ]);
    focusXPSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    focusXPSheet.setFrozenRows(1);
    focusXPSheet.appendRow([1, 0, 0, 0, 0, 0]);
  }

  // Tạo sheet Settings (cho auto-update URL)
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SHEET_SETTINGS);
    settingsSheet.getRange(1, 1, 1, 3).setValues([
      ['Key', 'Value', 'UpdatedAt']
    ]);
    settingsSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    settingsSheet.setFrozenRows(1);
  }

  // Tạo sheet Playlist (cho music sync)
  let playlistSheet = ss.getSheetByName(SHEET_PLAYLIST);
  if (!playlistSheet) {
    playlistSheet = ss.insertSheet(SHEET_PLAYLIST);
    playlistSheet.getRange(1, 1, 1, 5).setValues([
      ['ID', 'Name', 'VideoId', 'URL', 'AddedAt']
    ]);
    playlistSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    playlistSheet.setFrozenRows(1);
  }

  return { success: true, message: 'Setup hoàn tất! Sheets đã được tạo.' };
}

// ============================================================
// GET FUNCTIONS
// ============================================================

/**
 * Normalize date value from Google Sheets to YYYY-MM-DD string.
 * Google Sheets tự động chuyển string '2026-03-02' thành Date object.
 * Hàm này đảm bảo luôn trả về format 'YYYY-MM-DD'.
 */
function normalizeDateValue(val) {
  if (!val) return '';
  // Nếu là Date object (Google Sheets auto-convert)
  if (val instanceof Date) {
    return formatDate(val);
  }
  var str = String(val);
  // Đã đúng format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // ISO string: '2026-03-02T00:00:00.000Z'
  if (str.indexOf('T') > -1) return str.split('T')[0];
  // Format khác (e.g. 'Mon Mar 02 2026...') → parse lại
  try {
    var d = new Date(str);
    if (!isNaN(d.getTime())) {
      return formatDate(d);
    }
  } catch(e) { }
  return str;
}
function getHabits() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_HABITS);
  const data = sheet.getDataRange().getValues();
  
  if (data.length <= 1) return { success: true, habits: [] };
  
  const habits = data.slice(1).map(row => ({
    id: row[0],
    name: row[1],
    icon: row[2],
    color: row[3],
    createdAt: row[4],
    active: row[5] === '' ? true : (row[5] === true || row[5] === 'TRUE')
  })).filter(h => h.id);
  
  return { success: true, habits };
}

function getCompletions(year, month) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_COMPLETIONS);
  const data = sheet.getDataRange().getValues();
  
  if (data.length <= 1) return { success: true, completions: [] };
  
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const completions = data.slice(1)
    .map(row => ({
      habitId: row[0],
      date: normalizeDateValue(row[1]),
      completedAt: row[2]
    }))
    .filter(c => c.habitId && c.date && c.date.startsWith(prefix));
  
  return { success: true, completions };
}

function getStats() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const habitsSheet = ss.getSheetByName(SHEET_HABITS);
  const completionsSheet = ss.getSheetByName(SHEET_COMPLETIONS);
  
  const habits = habitsSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0]).map(r => ({ id: r[0], name: r[1] }));
  
  const allCompletions = completionsSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0]).map(r => ({ habitId: r[0], date: normalizeDateValue(r[1]) }));
  
  const today = formatDate(new Date());
  const streaks = {};
  
  habits.forEach(habit => {
    let streak = 0;
    let checkDate = new Date();
    
    while (true) {
      const dateStr = formatDate(checkDate);
      const done = allCompletions.some(
        c => c.habitId === habit.id && c.date === dateStr
      );
      if (!done) break;
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
    
    streaks[habit.id] = streak;
  });
  
  const last30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = formatDate(d);
    const completed = allCompletions.filter(c => c.date === dateStr).length;
    const total = habits.length;
    last30.push({
      date: dateStr,
      completed,
      total,
      points: total > 0 ? Math.round((completed / total) * 100) : 0
    });
  }
  
  const maxStreak = Math.max(0, ...Object.values(streaks));
  const avg30 = last30.reduce((sum, d) => sum + d.points, 0) / 30;
  
  return {
    success: true,
    stats: {
      totalHabits: habits.length,
      currentStreak: maxStreak,
      consistencyScore: Math.round(avg30),
      last30Days: last30,
      streaks
    }
  };
}

function getAllData() {
  const habitsResult = getHabits();
  const statsResult = getStats();
  const allCompletions = getAllCompletions();
  const allJournal = getJournal();
  const focusData = getFocusData();
  
  return {
    success: true,
    habits: habitsResult.habits,
    completions: allCompletions,
    stats: statsResult.stats,
    journal: allJournal,
    focusHistory: focusData.focusHistory || [],
    focusXP: focusData.focusXP || null,
    playlist: getPlaylist().playlist || [],
    spreadsheetId: SPREADSHEET_ID
  };
}

function getAllCompletions() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_COMPLETIONS);
  const data = sheet.getDataRange().getValues();
  
  if (data.length <= 1) return [];
  
  return data.slice(1)
    .filter(row => row[0] && row[1])
    .map(row => ({
      habitId: row[0],
      date: normalizeDateValue(row[1]),
      completedAt: row[2]
    }));
}

// ============================================================
// POST FUNCTIONS
// ============================================================
function addHabit(name, icon, color, active = true) {
  if (!name) return { success: false, error: 'Tên habit không được trống' };
  
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_HABITS);
  
  const newHabit = {
    id: generateId(),
    name: name,
    icon: icon || '⭐',
    color: color || '#6366f1',
    createdAt: new Date().toISOString(),
    active: active
  };
  
  sheet.appendRow([
    newHabit.id, newHabit.name, newHabit.icon,
    newHabit.color, newHabit.createdAt, newHabit.active
  ]);
  
  return { success: true, habit: newHabit };
}

function deleteHabit(habitId) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_HABITS);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === habitId) {
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Đã xoá habit' };
    }
  }
  
  return { success: false, error: 'Không tìm thấy habit' };
}

function toggleCompletion(habitId, date) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_COMPLETIONS);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const rowHabitId = String(data[i][0]);
    let rowDate = normalizeDateValue(data[i][1]);
    
    if (rowHabitId === habitId && rowDate === date) {
      sheet.deleteRow(i + 1);
      return { success: true, completed: false, message: 'Đã bỏ đánh dấu' };
    }
  }
  
  sheet.appendRow([habitId, date, new Date().toISOString()]);
  return { success: true, completed: true, message: 'Đã đánh dấu hoàn thành' };
}

function updateHabit(habitId, name, icon, color, active) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_HABITS);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === habitId) {
      if (name !== undefined) sheet.getRange(i + 1, 2).setValue(name);
      if (icon !== undefined) sheet.getRange(i + 1, 3).setValue(icon);
      if (color !== undefined) sheet.getRange(i + 1, 4).setValue(color);
      if (active !== undefined) sheet.getRange(i + 1, 6).setValue(active);
      return { success: true, message: 'Đã cập nhật habit' };
    }
  }
  
  return { success: false, error: 'Không tìm thấy habit' };
}

// ============================================================
// JOURNAL FUNCTIONS
// ============================================================
function getJournal() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_JOURNAL);
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  return data.slice(1)
    .filter(row => row[0])
    .map(row => {
      return {
        date: normalizeDateValue(row[0]),
        mood: String(row[1] || ''),
        content: String(row[2] || ''),
        updatedAt: row[3] || ''
      };
    });
}

function saveJournal(date, mood, content) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_JOURNAL);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_JOURNAL);
    sheet.getRange(1, 1, 1, 4).setValues([['Date', 'Mood', 'Content', 'UpdatedAt']]);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  
  const data = sheet.getDataRange().getValues();
  const now = new Date().toISOString();
  
  for (let i = 1; i < data.length; i++) {
    let rowDate = normalizeDateValue(data[i][0]);
    
    if (rowDate === date) {
      sheet.getRange(i + 1, 2).setValue(mood);
      sheet.getRange(i + 1, 3).setValue(content);
      sheet.getRange(i + 1, 4).setValue(now);
      return { success: true, message: 'Đã cập nhật ghi chú', updated: true };
    }
  }
  
  sheet.appendRow([date, mood, content, now]);
  return { success: true, message: 'Đã lưu ghi chú', updated: false };
}

// ============================================================
// FOCUS FUNCTIONS
// ============================================================
function getFocusData() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  
  // Helper: normalize date value to YYYY-MM-DD string
  function normalizeDateStr(val) {
    if (!val) return '';
    // If it's a Date object from Google Sheets
    if (val instanceof Date) {
      return Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    var str = String(val);
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // ISO string: "2026-03-02T00:00:00.000Z"
    if (str.indexOf('T') > -1) return str.split('T')[0];
    // Try to parse
    try {
      var d = new Date(str);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
    } catch(e) { }
    return str;
  }
  
  // Focus History
  let histSheet = ss.getSheetByName(SHEET_FOCUS_HISTORY);
  let focusHistory = [];
  if (histSheet) {
    const data = histSheet.getDataRange().getValues();
    if (data.length > 1) {
      focusHistory = data.slice(1).filter(r => r[0]).map(r => ({
        id: String(r[0]),
        date: normalizeDateStr(r[1]),
        mode: String(r[2]),
        duration: Number(r[3]),
        points: Number(r[4]),
        reward: r[5] ? String(r[5]) : null,
        createdAt: normalizeDateStr(r[6])
      }));
    }
  }

  // Focus XP
  let xpSheet = ss.getSheetByName(SHEET_FOCUS_XP);
  let focusXP = null;
  if (xpSheet) {
    const data = xpSheet.getDataRange().getValues();
    if (data.length > 1) {
      const r = data[1];
      focusXP = {
        level: Number(r[0]) || 1,
        currentXP: Number(r[1]) || 0,
        totalXP: Number(r[2]) || 0,
        totalPoints: Number(r[3]) || 0,
        totalSessions: Number(r[4]) || 0,
        totalTimeSec: Number(r[5]) || 0
      };
    }
  }

  return { success: true, focusHistory, focusXP };
}

function saveFocusSession(session) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_FOCUS_HISTORY);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FOCUS_HISTORY);
    sheet.getRange(1, 1, 1, 7).setValues([
      ['ID', 'Date', 'Mode', 'Duration', 'Points', 'Reward', 'CreatedAt']
    ]);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // Check duplicate by ID
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(session.id)) {
      if (session.reward) sheet.getRange(i + 1, 6).setValue(session.reward);
      return { success: true, message: 'Session đã tồn tại' };
    }
  }

  sheet.appendRow([
    session.id,
    session.date,
    session.mode,
    session.duration,
    session.points,
    session.reward || '',
    new Date().toISOString()
  ]);

  return { success: true, message: 'Đã lưu phiên tập trung' };
}

function saveFocusXP(xpState) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_FOCUS_XP);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_FOCUS_XP);
    sheet.getRange(1, 1, 1, 6).setValues([
      ['Level', 'CurrentXP', 'TotalXP', 'TotalPoints', 'TotalSessions', 'TotalTimeSec']
    ]);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const data = sheet.getDataRange().getValues();
  if (data.length > 1) {
    sheet.getRange(2, 1, 1, 6).setValues([[
      xpState.level || 1,
      xpState.currentXP || 0,
      xpState.totalXP || 0,
      xpState.totalPoints || 0,
      xpState.totalSessions || 0,
      xpState.totalTimeSec || 0
    ]]);
  } else {
    sheet.appendRow([
      xpState.level || 1,
      xpState.currentXP || 0,
      xpState.totalXP || 0,
      xpState.totalPoints || 0,
      xpState.totalSessions || 0,
      xpState.totalTimeSec || 0
    ]);
  }

  return { success: true, message: 'Đã lưu XP state' };
}

function syncFocusData(history, xpState) {
  if (history && history.length > 0) {
    for (const session of history) {
      saveFocusSession(session);
    }
  }
  if (xpState) {
    saveFocusXP(xpState);
  }
  return { success: true, message: 'Đã đồng bộ Focus data' };
}

// ============================================================
// PLAYLIST FUNCTIONS (Music Sync)
// ============================================================
function getPlaylist() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PLAYLIST);
  if (!sheet) return { success: true, playlist: [] };
  
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { success: true, playlist: [] };
  
  var playlist = data.slice(1).filter(function(r) { return r[0]; }).map(function(r) {
    return {
      id: String(r[0]),
      name: String(r[1]),
      videoId: String(r[2]),
      url: String(r[3]),
      addedAt: String(r[4])
    };
  });
  
  return { success: true, playlist: playlist };
}

function savePlaylistTrack(track) {
  if (!track || !track.videoId) return { success: false, error: 'Track data required' };
  
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PLAYLIST);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_PLAYLIST);
    sheet.getRange(1, 1, 1, 5).setValues([['ID', 'Name', 'VideoId', 'URL', 'AddedAt']]);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  
  // Check duplicate by videoId
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][2]) === String(track.videoId)) {
      return { success: true, message: 'Track already exists' };
    }
  }
  
  sheet.appendRow([
    track.id || 'mt_' + Date.now(),
    track.name || 'YouTube Video',
    track.videoId,
    track.url || '',
    track.addedAt || new Date().toISOString()
  ]);
  
  return { success: true, message: 'Track saved' };
}

function deletePlaylistTrack(trackId) {
  if (!trackId) return { success: false, error: 'Track ID required' };
  
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_PLAYLIST);
  if (!sheet) return { success: false, error: 'Playlist sheet not found' };
  
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(trackId)) {
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Track deleted' };
    }
  }
  
  return { success: false, error: 'Track not found' };
}

// ============================================================
// AUTO-UPDATE DEPLOYMENT URL
// Cho phép app tự phát hiện API URL mới khi deploy lại.
// URL được lưu trong Settings sheet → tất cả deployment đều đọc được.
// ============================================================
function getLatestDeploymentUrl() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) return { success: true, url: null };
  
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === 'latestApiUrl') {
      return { 
        success: true, 
        url: String(data[i][1]) || null,
        updatedAt: data[i][2] ? String(data[i][2]) : null
      };
    }
  }
  return { success: true, url: null };
}

function registerDeploymentUrl(url) {
  if (!url) return { success: false, error: 'URL is required' };
  
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SETTINGS);
    sheet.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'UpdatedAt']]);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  
  var data = sheet.getDataRange().getValues();
  var now = new Date().toISOString();
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === 'latestApiUrl') {
      sheet.getRange(i + 1, 2).setValue(url);
      sheet.getRange(i + 1, 3).setValue(now);
      return { success: true, message: 'API URL updated', updatedAt: now };
    }
  }
  
  sheet.appendRow(['latestApiUrl', url, now]);
  return { success: true, message: 'API URL registered', updatedAt: now };
}

// ============================================================
// UTILS
// ============================================================
function generateId() {
  return 'h_' + Math.random().toString(36).substr(2, 9) + Date.now();
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
