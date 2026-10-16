(function () {
  'use strict';

  var STORAGE_KEY = 'mypeor.local.v1';
  var LEGACY_STORAGE_KEY = STORAGE_KEY;
  var DATABASE_VERSION = 1;
  var DATABASE_NAME = 'mypeor.local.v1.' + (location.pathname.split('/').filter(Boolean)[0] || 'root').replace(/[^a-z0-9_-]/gi, '_');
  var STATE_KEY = 'current';
  var todayKey = function () {
    var timeZone = state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    } catch (error) {
      console.error('Invalid configured timezone; using the browser timezone.', error);
      parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    }
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  };
  var makeId = function () {
    return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  };
  var freshState = function () {
    return {
      tasks: [], schedule: [], classSchedules: [], subjects: [], assessments: [], exams: [], studySessions: [], flashcards: [], lessons: [], lessonAttachments: [], habits: [], habitLogs: [],
      timetablePreferences: { startHour: 7, endHour: 21 },
      preferences: { name: '', theme: 'system', timezone: 'Asia/Manila', dateFormat: 'medium', timeFormat: '12h', focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, notifications: false, sidebarCollapsed: false },
      timer: { phase: 'focus', status: 'idle', endAt: null, remainingMs: 25 * 60000, focusCount: 0, completedSessions: [] },
      quoteIndex: 0,
      notifications: [],
      dismissedReminders: [],
      demoMode: false,
      schemaVersion: DATABASE_VERSION
    };
  };

  var state = freshState();
  var currentPage = 'dashboard';
  var taskView = 'all';
  var taskSearch = '';
  var taskCategoryFilter = 'all';
  var taskPriorityFilter = 'all';
  var taskSort = 'due';
  var globalSearch = '';
  var searchFilters = { type: 'all', subject: 'all', priority: 'all', status: 'all', due: 'all' };
  var deadlineFilters = { type: 'all', subject: 'all', priority: 'all', status: 'incomplete' };
  var showDismissedNotifications = false;
  var calendarDate = parseDate(todayKey());
  var calendarView = 'month';
  var scheduleTab = 'timetable';
  var academicsTab = 'subjects';
  var timetableView = 'week';
  var timetableWeekOffset = 0;
  var timetableDay = new Date().getDay();
  var revealedFlashcards = new Set();
  var lessonSubjectId = '';
  var lessonSearch = '';
  var lessonStatusFilter = 'all';
  var lessonSort = 'order';
  var lessonIntroPending = false;
  var dashboardIntroPlayed = false;
  var taskCompletionPulseId = '';
  var taskCompletionCelebration = false;
  var timerPhaseChanged = false;
  var progressSignature = '';
  var progressAnimationPending = false;
  var selectedDate = todayKey();
  var progressRange = 'week';
  var customRange = { start: todayKey(), end: todayKey() };
  var timerInterval = null;
  var storageAvailable = true;
  var databasePromise = null;
  var saveQueue = Promise.resolve();
  var saveRevision = 0;
  var settingsSaveTimer = null;
  var storageStatus = 'loading';
  var storageErrorMessage = '';

  var main = document.querySelector('#main-content');
  var modal = document.querySelector('#modal');
  var modalBody = document.querySelector('#modal-body');
  var modalTitle = document.querySelector('#modal-title');
  var modalReturnFocus = null;

  function normalizeState(parsed, rejectInvalid) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Backup must contain a JSON object.');
    var source = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : parsed;
    if (source.schemaVersion && source.schemaVersion > DATABASE_VERSION) throw new Error('This backup was created by a newer My PeOr version. Update the website before importing it.');
    var base = Object.assign(freshState(), source);
    base.preferences = Object.assign(freshState().preferences, source.preferences || {});
    base.timer = Object.assign(freshState().timer, source.timer || {});
    base.timetablePreferences = Object.assign(freshState().timetablePreferences, source.timetablePreferences || {});
    if (!Array.isArray(base.timer.completedSessions)) {
      if (source.timer && source.timer.completedSessions !== undefined) throw new Error('Backup timer sessions must be a list.');
      base.timer.completedSessions = [];
    }
    var arrayKeys = ['tasks', 'schedule', 'classSchedules', 'subjects', 'assessments', 'exams', 'studySessions', 'flashcards', 'lessons', 'lessonAttachments', 'habits', 'habitLogs', 'notifications', 'dismissedReminders'];
    arrayKeys.forEach(function (key) {
      if (source[key] !== undefined && !Array.isArray(source[key])) throw new Error('Backup field "' + key + '" must be a list.');
      if (!Array.isArray(base[key])) base[key] = [];
    });
    if (source.preferences !== undefined && (!source.preferences || typeof source.preferences !== 'object' || Array.isArray(source.preferences))) {
      throw new Error('Backup preferences must be an object.');
    }
    if (source.timer !== undefined && (!source.timer || typeof source.timer !== 'object' || Array.isArray(source.timer))) {
      throw new Error('Backup timer data must be an object.');
    }
    if (source.timetablePreferences !== undefined && (!source.timetablePreferences || typeof source.timetablePreferences !== 'object' || Array.isArray(source.timetablePreferences))) {
      throw new Error('Backup timetable preferences must be an object.');
    }
    base.timetablePreferences.startHour = Math.max(0, Math.min(23, Number(base.timetablePreferences.startHour) || 0));
    base.timetablePreferences.endHour = Math.max(base.timetablePreferences.startHour + 1, Math.min(24, Number(base.timetablePreferences.endHour) || 24));
    var ids = new Set();
    ['tasks', 'schedule', 'classSchedules', 'subjects', 'assessments', 'exams', 'studySessions', 'flashcards', 'lessons', 'lessonAttachments', 'habits', 'habitLogs', 'notifications'].forEach(function (key) {
      base[key].forEach(function (item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Backup field "' + key + '" contains an invalid item.');
        if (!item.id || ids.has(item.id)) {
          if (rejectInvalid && item.id) throw new Error('Backup contains duplicate item IDs.');
          item.id = makeId();
        }
        ids.add(item.id);
      });
    });
    base.lessonAttachments.forEach(function (item) {
      if (!(item.data instanceof Blob)) throw new Error('Lesson attachment data is missing or invalid.');
      if (!item.name || !item.subjectId || !Number.isFinite(Number(item.size))) throw new Error('A lesson attachment is missing required metadata.');
      if (item.size !== item.data.size || item.size > 15 * 1024 * 1024) throw new Error('A lesson attachment has an invalid size.');
      if (!base.subjects.some(function (subject) { return subject.id === item.subjectId; })) throw new Error('A lesson attachment references a subject that is not in this backup.');
      if (item.lessonId && !base.lessons.some(function (lesson) { return lesson.id === item.lessonId && lesson.subjectId === item.subjectId; })) throw new Error('A lesson attachment references a lesson that is not in this backup.');
    });
    if (base.lessonAttachments.reduce(function (sum, item) { return sum + Number(item.size); }, 0) > 50 * 1024 * 1024) {
      throw new Error('Lesson attachments in this backup exceed the 50 MB local limit.');
    }
    base.lessons.forEach(function (item) {
      if (!item.subjectId || !item.title) throw new Error('A lesson is missing its subject or title.');
      if (!base.subjects.some(function (subject) { return subject.id === item.subjectId; })) throw new Error('A lesson references a subject that is not in this backup.');
    });
    base.timer.completedSessions.forEach(function (session) {
      if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Backup contains an invalid completed study session.');
      if (!session.id || ids.has(session.id)) {
        if (rejectInvalid && session.id) throw new Error('Backup contains duplicate item IDs.');
        session.id = makeId();
      }
      ids.add(session.id);
    });
    base.schemaVersion = DATABASE_VERSION;
    return base;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB is not supported in this browser.'));
        return;
      }
      var request;
      try {
        request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains('appState')) database.createObjectStore('appState', { keyPath: 'key' });
      };
      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () { database.close(); };
        resolve(database);
      };
      request.onerror = function () { reject(request.error || new Error('Could not open IndexedDB.')); };
      request.onblocked = function () { reject(new Error('IndexedDB upgrade is blocked by another open My PeOr tab. Close the other tab and reload.')); };
    });
    return databasePromise;
  }

  function readDatabaseState(database) {
    return new Promise(function (resolve, reject) {
      var transaction;
      try {
        transaction = database.transaction('appState', 'readonly');
      } catch (error) {
        reject(error);
        return;
      }
      var request = transaction.objectStore('appState').get(STATE_KEY);
      request.onsuccess = function () {
        try {
          resolve(request.result ? normalizeState(request.result.state, false) : null);
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = function () { reject(request.error || new Error('Could not read saved My PeOr data.')); };
    });
  }

  async function loadState() {
    try {
      var database = await openDatabase();
      var savedState = await readDatabaseState(database);
      if (savedState) {
        state = savedState;
      } else {
        var legacy = null;
        try {
          legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        } catch (error) {
          console.warn('Legacy localStorage could not be checked; continuing with IndexedDB.', error);
        }
        if (legacy) {
          state = normalizeState(JSON.parse(legacy), false);
          await writeState(database, state);
          try {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
          } catch (error) {
            console.warn('Legacy localStorage data remains but has been migrated to IndexedDB.', error);
          }
        }
      }
      storageAvailable = true;
      storageErrorMessage = '';
      storageStatus = 'saved';
    } catch (error) {
      storageAvailable = false;
      storageStatus = 'error';
      storageErrorMessage = error && error.message ? error.message : 'Browser storage could not be opened.';
      console.error('Unable to load My PeOr IndexedDB data.', error);
      try {
        var legacyData = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyData) state = normalizeState(JSON.parse(legacyData), false);
      } catch (legacyError) {
        console.error('Unable to recover legacy My PeOr browser data.', legacyError);
      }
    }
    if (state.timer.status === 'running' && state.timer.endAt && state.timer.endAt <= Date.now()) {
      state.timer.status = 'paused';
      state.timer.remainingMs = 0;
      state.timer.endAt = null;
      state.timer.recoveredExpired = true;
    }
    migrateReminderData();
  }

  function migrateReminderData() {
    ['tasks', 'exams', 'schedule', 'studySessions'].forEach(function (collection) {
      state[collection].forEach(function (item) {
        if (!Array.isArray(item.reminderOffsets)) item.reminderOffsets = [];
      });
    });
  }

  function writeState(database, value) {
    return new Promise(function (resolve, reject) {
      var transaction;
      try {
        transaction = database.transaction('appState', 'readwrite');
        transaction.objectStore('appState').put({ key: STATE_KEY, schemaVersion: DATABASE_VERSION, updatedAt: new Date().toISOString(), state: value });
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('Could not save changes to browser storage.')); };
      transaction.onabort = function () { reject(transaction.error || new Error('Browser storage transaction was cancelled.')); };
    });
  }

  function setStorageStatus(status, message) {
    storageStatus = status;
    storageErrorMessage = message || '';
    storageAvailable = status !== 'error';
    var indicator = document.querySelector('#storage-status');
    if (!indicator) return;
    var labels = { loading: 'Loading…', saving: 'Saving…', saved: 'Saved locally', error: 'Unable to save' };
    indicator.className = 'storage-status is-' + status;
    indicator.querySelector('span').textContent = labels[status] || 'Storage status';
    indicator.title = message || (status === 'saved' ? 'Your changes are saved in this browser.' : status === 'saving' ? 'Saving changes to this browser.' : 'Loading saved browser data.');
    indicator.setAttribute('aria-label', labels[status] + (message ? ': ' + message : ''));
  }

  function saveState() {
    syncReminderQueue();
    state.schemaVersion = DATABASE_VERSION;
    var revision = ++saveRevision;
    var snapshot;
    try {
      snapshot = cloneState(state);
    } catch (error) {
      setStorageStatus('error', 'The current data could not be prepared for saving.');
      console.error('Unable to serialize My PeOr browser data.', error);
      return;
    }
    setStorageStatus('saving');
    saveQueue = saveQueue.catch(function () {}).then(async function () {
      var database = await openDatabase();
      await writeState(database, snapshot);
      if (revision === saveRevision) setStorageStatus('saved');
    return true;
    }).catch(function (error) {
      if (revision === saveRevision) {
        var message = error && error.name === 'QuotaExceededError'
          ? 'Browser storage is full. Export a backup or remove some large attachments, then try again.'
          : error && error.message ? error.message : 'Browser storage rejected the save.';
        setStorageStatus('error', message);
        console.error('Unable to save My PeOr IndexedDB data.', error);
        toast('Unable to save locally. ' + message, true);
      }
      return false;
    });
    return saveQueue;
  }

  function cloneState(value) {
    if (value instanceof Blob) return value.slice(0, value.size, value.type);
    if (Array.isArray(value)) return value.map(cloneState);
    if (value && typeof value === 'object') {
      var copy = {};
      Object.keys(value).forEach(function (key) { copy[key] = cloneState(value[key]); });
      return copy;
    }
    return value;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function localDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function dateInConfiguredTimezone(date) {
    var options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone };
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
    } catch (error) {
      parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    }
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function timeInConfiguredTimezone(date) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
      }).format(date);
    } catch (error) {
      return date.toTimeString().slice(0, 5);
    }
  }

  function zonedDateTimeToEpoch(value) {
    if (!value) return NaN;
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) return NaN;
    var requested = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
    var zone = state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    var result = requested;
    for (var i = 0; i < 3; i += 1) {
      var parts;
      try {
        parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        }).formatToParts(new Date(result));
      } catch (error) {
        return new Date(value).getTime();
      }
      var values = {};
      parts.forEach(function (part) { values[part.type] = Number(part.value); });
      var representedAsUtc = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute);
      result += requested - representedAsUtc;
    }
    return result;
  }

  function itemDueEpoch(item, collection) {
    if (!item || !item.date && !item.dueDate) return NaN;
    var date = item.dueDate || item.date;
    var time = item.dueTime || item.time || (collection === 'schedule' || collection === 'studySessions' ? item.startTime : '') || '23:59';
    return zonedDateTimeToEpoch(date + 'T' + time);
  }

  function itemCollectionForType(type) {
    return type === 'task' ? 'tasks' : type === 'exam' ? 'exams' : type === 'event' ? 'schedule' : 'studySessions';
  }

  function itemTitle(item, type) {
    return item.title || item.topic || item.name || (type === 'event' ? 'Schedule activity' : 'Organizer reminder');
  }

  function reminderChoices(selected) {
    selected = Array.isArray(selected) ? selected.map(String) : [];
    var options = [['0', 'At the deadline'], ['10', '10 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['1440', '1 day before']];
    return '<div class="form-field full"><span class="form-field-label">Reminder times</span><div class="reminder-options">' +
      options.map(function (option) {
        return '<label class="reminder-option"><input type="checkbox" name="reminderOffsets" value="' + option[0] + '"' + (selected.includes(option[0]) ? ' checked' : '') + '><span>' + option[1] + '</span></label>';
    }).join('') + '</div><small class="form-hint">In-app reminders and browser notifications are checked only while My PeOr is open. Browser alerts require permission; no background push service is configured.</small></div>';
  }

  function reminderDefinitions() {
    var groups = [
      { type: 'task', collection: 'tasks', dateField: 'dueDate', timeField: 'dueTime' },
      { type: 'exam', collection: 'exams', dateField: 'date', timeField: 'time' },
      { type: 'event', collection: 'schedule', dateField: 'date', timeField: 'startTime' },
      { type: 'study', collection: 'studySessions', dateField: 'date', timeField: 'startTime' }
    ];
    var definitions = [];
    groups.forEach(function (group) {
      state[group.collection].forEach(function (item) {
        if (item.status === 'Completed' || item.prepStatus === 'Completed') return;
        var dueAt = itemDueEpoch(item, group.collection);
        if (!isFinite(dueAt)) return;
        var offsets = Array.isArray(item.reminderOffsets) ? item.reminderOffsets : [];
        offsets.forEach(function (offset) {
          var minutes = Number(offset);
          if (!isFinite(minutes) || minutes < 0) return;
          definitions.push({
            id: ['reminder', group.type, item.id, dueAt, minutes].join(':'),
            entityType: group.type,
            entityId: item.id,
            title: itemTitle(item, group.type),
            offset: minutes,
            dueAt: dueAt,
            remindAt: dueAt - minutes * 60000
          });
        });
        if (item.reminderAt && !offsets.length && !state.dismissedReminders.includes(item.id)) {
          var legacyReminderAt = zonedDateTimeToEpoch(item.reminderAt);
          if (isFinite(legacyReminderAt)) {
            definitions.push({
              id: ['reminder', group.type, item.id, dueAt, 'legacy', legacyReminderAt].join(':'),
              entityType: group.type,
              entityId: item.id,
              title: itemTitle(item, group.type),
              offset: null,
              dueAt: dueAt,
              remindAt: legacyReminderAt
            });
          }
        }
      });
    });
    return definitions;
  }

  function syncReminderQueue() {
    var definitions = reminderDefinitions();
    var activeIds = new Set(definitions.map(function (item) { return item.id; }));
    var existing = new Map(state.notifications.map(function (item) { return [item.id, item]; }));
    var changed = false;
    var next = state.notifications.filter(function (notification) {
      return notification.status !== 'scheduled' || activeIds.has(notification.id);
    });
    definitions.forEach(function (definition) {
      var previous = existing.get(definition.id);
      if (previous) {
        if (previous.status === 'scheduled' &&
          (previous.title !== definition.title || previous.dueAt !== definition.dueAt || previous.remindAt !== definition.remindAt)) {
          Object.assign(previous, definition);
          changed = true;
        }
        return;
      }
      next.push(Object.assign({}, definition, {
        status: 'scheduled',
        readAt: null,
        dismissedAt: null,
        createdAt: new Date().toISOString()
      }));
      changed = true;
    });
    if (next.length !== state.notifications.length || next.some(function (notification, index) {
      return notification.id !== state.notifications[index].id;
    })) {
      state.notifications = next;
      return true;
    }
    return changed;
  }

  function cancelItemReminders(type, id) {
    state.notifications = state.notifications.filter(function (notification) {
      return !(notification.entityType === type && notification.entityId === id && notification.status === 'scheduled');
    });
  }

  function taskDeadlineState(item) {
    if (item.status === 'Completed') return 'Completed';
    if (!item.dueDate) return 'Upcoming';
    var days = dayDifference(item.dueDate);
    if (days < 0) return 'Overdue';
    if (days > 0) return days === 1 ? 'Due Tomorrow' : days <= 7 ? 'Due This Week' : 'Upcoming';
    if (itemDueEpoch(item, 'tasks') < Date.now()) return 'Overdue';
    return 'Due Today';
  }

  function remainingDeadline(item, collection) {
    if (item.status === 'Completed' || item.prepStatus === 'Completed') return 'Completed';
    var due = itemDueEpoch(item, collection);
    if (!isFinite(due)) return 'No due date';
    var delta = due - Date.now();
    var remainingDays = dayDifference(dateInConfiguredTimezone(new Date(due)));
    if (delta < 0) {
      if (remainingDays === 0) return 'Overdue today';
      var overdueDays = Math.max(1, Math.abs(remainingDays));
      return 'Overdue by ' + overdueDays + (overdueDays === 1 ? ' day' : ' days');
    }
    if (remainingDays === 1) return 'Due tomorrow';
    if (remainingDays > 1) return 'Due in ' + remainingDays + ' days';
    if (delta < 60000) return 'Due in less than a minute';
    if (delta < 3600000) return 'Due in ' + Math.ceil(delta / 60000) + ' minutes';
    if (delta < 86400000) return 'Due in ' + Math.floor(delta / 3600000) + 'h ' + Math.floor((delta % 3600000) / 60000) + 'm';
    return 'Due soon';
  }

  function parseDate(dateString) {
    if (!dateString) return null;
    var parts = dateString.split('-').map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function dayDifference(dateString, baseDate) {
    var date = parseDate(dateString);
    var base = baseDate || parseDate(todayKey());
    if (!date || !base) return null;
    return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(base.getFullYear(), base.getMonth(), base.getDate())) / 86400000);
  }

  function dateLabel(dateString, options) {
    var date = parseDate(dateString);
    if (!date) return 'No date';
    if (!options && state.preferences.dateFormat === 'iso') return localDate(date);
    if (!options && state.preferences.dateFormat === 'short') return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' }).format(date);
    options = options || {};
    return new Intl.DateTimeFormat(undefined, Object.assign({
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    }, options)).format(date);
  }

  function timeLabel(value) {
    if (!value) return '';
    var parts = value.split(':');
    var hours = Number(parts[0]);
    var minutes = String(Number(parts[1] || 0)).padStart(2, '0');
    if (state.preferences.timeFormat === '24h') return String(hours).padStart(2, '0') + ':' + minutes;
    return (hours % 12 || 12) + ':' + minutes + ' ' + (hours >= 12 ? 'PM' : 'AM');
  }

  function dateTimeLabel(value) {
    if (!value) return '';
    var isAbsolute = typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    var date = new Date(isAbsolute ? value : zonedDateTimeToEpoch(value));
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
    }).format(date);
  }

  function currentTimeGreeting() {
    var hour;
    try {
      hour = Number(new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: state.preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
      }).format(new Date()));
    } catch (error) {
      console.error('Invalid configured timezone; using the browser timezone.', error);
      hour = new Date().getHours();
    }
    return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  }

  function subjectName(id) {
    var subject = state.subjects.find(function (item) { return item.id === id; });
    return subject ? subject.name : '';
  }

  function statusForTask(task) {
    if (task.status === 'Completed') return 'Completed';
    if (!task.dueDate) return task.status || 'To Do';
    var days = dayDifference(task.dueDate);
    if (days < 0) return 'Overdue';
    if (days === 0) return 'Due Today';
    return 'Upcoming';
  }

  function dueHint(task) {
    if (!task.dueDate) return 'No due date';
    var days = dayDifference(task.dueDate);
    if (task.status === 'Completed') return 'Completed';
    if (days < 0) return 'Overdue by ' + Math.abs(days) + (Math.abs(days) === 1 ? ' day' : ' days');
    if (days === 0) {
      if (itemDueEpoch(task, 'tasks') < Date.now()) return 'Overdue today';
      return task.dueTime ? 'Today at ' + timeLabel(task.dueTime) : 'Due today';
    }
    if (days === 1) return 'Due tomorrow';
    return 'Due in ' + days + ' days';
  }

  function statusClass(status) {
    if (status === 'Completed') return 'status-completed';
    if (status === 'Overdue') return 'status-overdue';
    if (status === 'Due Today') return 'status-today';
    return 'status-upcoming';
  }

  function priorityClass(priority) {
    return 'priority-' + String(priority || 'Medium').toLowerCase();
  }

  function toast(message, isError, celebration) {
    var region = document.querySelector('#toast-region');
    var node = document.createElement('div');
    node.className = 'toast' + (isError ? ' error' : '') + (celebration ? ' celebration' : '');
    node.textContent = message;
    region.appendChild(node);
    window.setTimeout(function () { node.remove(); }, celebration ? 2400 : 2800);
  }

  function openModal(title, content, focusSelector) {
    modalReturnFocus = document.activeElement;
    modalTitle.textContent = title;
    modalBody.innerHTML = content;
    modal.hidden = false;
    var focusNode = modal.querySelector(focusSelector || 'input:not([type="hidden"]), select, textarea, button');
    if (focusNode) focusNode.focus();
  }

  function closeModal() {
    modal.hidden = true;
    modalBody.innerHTML = '';
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  }

  function field(label, name, type, value, options) {
    options = options || {};
    var id = 'field-' + name;
    var required = options.required ? ' required' : '';
    var placeholder = options.placeholder ? ' placeholder="' + escapeHtml(options.placeholder) + '"' : '';
    var min = options.min != null ? ' min="' + options.min + '"' : '';
    var max = options.max != null ? ' max="' + options.max + '"' : '';
    var step = options.step ? ' step="' + options.step + '"' : '';
    var content;
    if (type === 'days') {
      var selectedDays = Array.isArray(value) ? value : [];
      content = '<div class="weekday-options">' + options.choices.map(function (choice) {
        var checked = selectedDays.indexOf(choice.value) >= 0 ? ' checked' : '';
        return '<label><input type="checkbox" name="' + name + '" value="' + escapeHtml(choice.value) + '"' + checked + '><span>' + escapeHtml(choice.label) + '</span></label>';
      }).join('') + '</div>';
    } else if (type === 'textarea') {
      content = '<textarea id="' + id + '" name="' + name + '"' + placeholder + required + '>' + escapeHtml(value || '') + '</textarea>';
    } else if (type === 'select') {
      content = '<select id="' + id + '" name="' + name + '"' + required + '>' + options.choices.map(function (choice) {
        var choiceValue = typeof choice === 'string' ? choice : choice.value;
        var choiceLabel = typeof choice === 'string' ? choice : choice.label;
        var selected = String(value == null ? options.default || '' : value) === choiceValue ? ' selected' : '';
        return '<option value="' + escapeHtml(choiceValue) + '"' + selected + '>' + escapeHtml(choiceLabel || 'Select…') + '</option>';
      }).join('') + '</select>';
    } else {
      content = '<input id="' + id + '" name="' + name + '" type="' + type + '" value="' + escapeHtml(value == null ? '' : value) + '"' + placeholder + min + max + step + required + '>';
    }
    return '<div class="form-field' + (options.full ? ' full' : '') + '"><label for="' + id + '">' + escapeHtml(label) + (options.required ? ' <span class="danger-text">*</span>' : '') + '</label>' + content + (options.hint ? '<small class="form-hint">' + escapeHtml(options.hint) + '</small>' : '') + '<small class="field-error"></small></div>';
  }

  function formFrame(type, record, fields, submitLabel) {
    var values = record || {};
    var body = '<form data-form="' + type + '" data-id="' + escapeHtml(values.id || '') + '"' + (values.subjectId ? ' data-subject-id="' + escapeHtml(values.subjectId) + '"' : '') + ' novalidate><div class="form-grid">' +
      fields.map(function (item) {
        return item.type === 'reminders' ? reminderChoices(values.reminderOffsets) :
          item.type === 'lessonNotes' ? '<div class="form-field full"><label for="field-notes">Lesson notes</label><div class="lesson-note-tools"><button class="button" type="button" data-action="lesson-note-format" data-format="bold"><strong>B</strong></button><button class="button" type="button" data-action="lesson-note-format" data-format="italic"><em>I</em></button><button class="button" type="button" data-action="lesson-note-format" data-format="list">• List</button><span class="form-hint">Select text to format. Notes support bold, italic, and bullet lists.</span></div><textarea id="field-notes" name="notes" rows="8">' + escapeHtml(values.notes || '') + '</textarea><small class="field-error"></small></div>' :
          field(item.label, item.name, item.type, values[item.name] != null ? values[item.name] : item.value, item);
      }).join('') +
      '</div><div class="form-actions"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">' + (submitLabel || 'Save') + '</button></div></form>';
    return body;
  }

  function openForm(type, record) {
    record = record || null;
    var id = record && record.id;
    var fields;
    var title;
    if (type === 'task') {
      title = id ? 'Edit task' : 'Add task';
      fields = [
        { label: 'Task title', name: 'title', type: 'text', required: true, full: true, placeholder: 'What needs to get done?' },
        { label: 'Description', name: 'description', type: 'textarea', full: true },
        { label: 'Due date', name: 'dueDate', type: 'date' },
        { label: 'Due time', name: 'dueTime', type: 'time' },
        { label: 'Priority', name: 'priority', type: 'select', choices: ['Low', 'Medium', 'High', 'Urgent'], value: 'Medium' },
        { label: 'Status', name: 'status', type: 'select', choices: ['To Do', 'In Progress', 'Completed'], value: 'To Do' },
        { label: 'Category', name: 'category', type: 'select', choices: ['Personal', 'School', 'Study', 'Project', 'Other'], value: 'Personal' },
        { label: 'Subject', name: 'subjectId', type: 'select', choices: [''].concat(state.subjects.map(function (item) { return item.id; })), hint: 'Optional' },
        { label: 'Estimated duration (minutes)', name: 'estimatedMinutes', type: 'number', min: 1, step: 1 },
        { label: 'Reminders', name: 'reminderOffsets', type: 'reminders' },
        { label: 'Recurrence', name: 'recurrence', type: 'select', choices: ['None', 'Daily', 'Weekly', 'Monthly'], value: 'None', hint: 'Saved as a preference; entries are not auto-created.' }
      ];
      fields[7].choices = [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; }));
    } else if (type === 'schedule') {
      title = id ? 'Edit schedule block' : 'Add schedule block';
      fields = [
        { label: 'Activity title', name: 'title', type: 'text', required: true, full: true },
        { label: 'Date', name: 'date', type: 'date', required: true, value: selectedDate },
        { label: 'Category', name: 'category', type: 'select', choices: ['Class', 'Study', 'Assignment', 'Exercise', 'Meal', 'Personal', 'Rest', 'Other'], value: 'Study' },
        { label: 'Start time', name: 'startTime', type: 'time', required: true },
        { label: 'End time', name: 'endTime', type: 'time', required: true },
        { label: 'Subject', name: 'subjectId', type: 'select', choices: [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; })) },
        { label: 'Description', name: 'description', type: 'textarea', full: true },
        { label: 'Reminders', name: 'reminderOffsets', type: 'reminders' }
      ];
    } else if (type === 'classSchedule') {
      title = id ? 'Edit class schedule' : 'Add class schedule';
      fields = [
        { label: 'Subject name', name: 'subjectName', type: 'text', required: true },
        { label: 'Subject code', name: 'subjectCode', type: 'text', hint: 'Optional' },
        { label: 'Link saved subject', name: 'subjectId', type: 'select', choices: [{ value: '', label: 'No linked subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; })) },
        { label: 'Days of the week', name: 'days', type: 'days', required: true, full: true, choices: [{ value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' }, { value: '3', label: 'Wednesday' }, { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' }, { value: '6', label: 'Saturday' }, { value: '0', label: 'Sunday' }] },
        { label: 'Start time', name: 'startTime', type: 'time', required: true },
        { label: 'End time', name: 'endTime', type: 'time', required: true },
        { label: 'Classroom or location', name: 'location', type: 'text', hint: 'Optional' },
        { label: 'Instructor', name: 'instructor', type: 'text', hint: 'Optional' },
        { label: 'Class color', name: 'color', type: 'color', value: '#5368d8' },
        { label: 'Notes', name: 'notes', type: 'textarea', full: true }
      ];
    } else if (type === 'flashcard') {
      title = id ? 'Edit flashcard' : 'Add flashcard';
      fields = [
        { label: 'Subject', name: 'subjectId', type: 'select', choices: [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; })) },
        { label: 'Question / front', name: 'question', type: 'textarea', required: true, full: true },
        { label: 'Answer / back', name: 'answer', type: 'textarea', required: true, full: true }
      ];
    } else if (type === 'subject') {
      title = id ? 'Edit subject' : 'Add subject';
      fields = [
        { label: 'Subject name', name: 'name', type: 'text', required: true },
        { label: 'Subject code', name: 'code', type: 'text' },
        { label: 'Folder icon', name: 'icon', type: 'text', placeholder: '▧', hint: 'Optional. Use a short symbol or emoji.' },
        { label: 'Folder color', name: 'color', type: 'color', value: '#5368d8', hint: 'Optional' },
        { label: 'Instructor', name: 'instructor', type: 'text' },
        { label: 'Semester / period', name: 'period', type: 'text' },
        { label: 'Target grade (%)', name: 'target', type: 'number', min: 0, max: 100, step: 'any' },
        { label: 'Description', name: 'description', type: 'textarea', full: true }
      ];
    } else if (type === 'lesson') {
      title = id ? 'Edit lesson' : 'Add lesson';
      fields = [
        { label: 'Lesson title', name: 'title', type: 'text', required: true, full: true },
        { label: 'Lesson number', name: 'lessonNumber', type: 'number', min: 1, step: 1, hint: 'Optional' },
        { label: 'Topic', name: 'topic', type: 'text', hint: 'Optional' },
        { label: 'Lesson date', name: 'date', type: 'date', hint: 'Optional' },
        { label: 'Review status', name: 'reviewStatus', type: 'select', choices: ['Not Reviewed', 'Reviewed'], value: 'Not Reviewed' },
        { label: 'Notes', name: 'notes', type: 'lessonNotes', full: true }
      ];
    } else if (type === 'assessment') {
      title = id ? 'Edit assessment' : 'Record grade';
      fields = [
        { label: 'Assessment name', name: 'name', type: 'text', required: true },
        { label: 'Subject', name: 'subjectId', type: 'select', required: true, choices: [{ value: '', label: 'Select a subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; })) },
        { label: 'Score earned', name: 'score', type: 'number', required: true, min: 0, step: 'any' },
        { label: 'Maximum score', name: 'maximum', type: 'number', required: true, min: 0.01, step: 'any' },
        { label: 'Assessment date', name: 'date', type: 'date' },
        { label: 'Weight (%)', name: 'weight', type: 'number', min: 0, max: 100, step: 'any', hint: 'Optional. Weighted average is shown only when entered weights total 100%.' }
      ];
      fields[1].choices = [{ value: '', label: 'Select a subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; }));
    } else if (type === 'exam') {
      title = id ? 'Edit exam' : 'Add exam';
      fields = [
        { label: 'Exam or quiz title', name: 'title', type: 'text', required: true, full: true },
        { label: 'Subject', name: 'subjectId', type: 'select', choices: [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; })) },
        { label: 'Date', name: 'date', type: 'date', required: true },
        { label: 'Time', name: 'time', type: 'time' },
        { label: 'Preparation status', name: 'prepStatus', type: 'select', choices: ['Not Started', 'Reviewing', 'Almost Ready', 'Completed'], value: 'Not Started' },
        { label: 'Priority', name: 'priority', type: 'select', choices: ['Low', 'Medium', 'High', 'Urgent'], value: 'Medium' },
        { label: 'Topics covered', name: 'topics', type: 'textarea', full: true },
        { label: 'Notes', name: 'notes', type: 'textarea', full: true },
        { label: 'Reminders', name: 'reminderOffsets', type: 'reminders' }
      ];
      fields[1].choices = [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; }));
    } else if (type === 'study') {
      title = id ? 'Edit study session' : 'Plan study session';
      fields = [
        { label: 'Subject', name: 'subjectId', type: 'select', choices: [''].concat(state.subjects.map(function (item) { return item.id; })) },
        { label: 'Topic', name: 'topic', type: 'text', required: true },
        { label: 'Planned date', name: 'date', type: 'date', required: true, value: selectedDate },
        { label: 'Start time', name: 'startTime', type: 'time' },
        { label: 'Planned duration (minutes)', name: 'plannedMinutes', type: 'number', min: 1, step: 1, value: 25 },
        { label: 'Status', name: 'status', type: 'select', choices: ['Planned', 'Completed'], value: 'Planned' },
        { label: 'Actual minutes studied', name: 'actualMinutes', type: 'number', min: 0, step: 1 },
        { label: 'Notes', name: 'notes', type: 'textarea', full: true },
        { label: 'Reminders', name: 'reminderOffsets', type: 'reminders' }
      ];
      fields[0].choices = [{ value: '', label: 'No subject' }].concat(state.subjects.map(function (item) { return { value: item.id, label: item.name }; }));
    } else if (type === 'habit') {
      title = id ? 'Edit habit' : 'Add habit';
      fields = [
        { label: 'Habit name', name: 'name', type: 'text', required: true, full: true },
        { label: 'Description', name: 'description', type: 'textarea', full: true },
        { label: 'Frequency', name: 'frequency', type: 'select', choices: ['Daily', 'Weekly'], value: 'Daily' },
        { label: 'Weekly target (days)', name: 'weeklyTarget', type: 'number', min: 1, max: 7, step: 1, value: 3, hint: 'Used for weekly habits.' },
        { label: 'Start date', name: 'startDate', type: 'date', value: todayKey() },
        { label: 'Status', name: 'active', type: 'select', choices: ['Active', 'Archived'], value: 'Active' }
      ];
    }
    if (!fields) return;
    openModal(title, formFrame(type, record, fields), 'input:not([type="hidden"]), select, textarea');
    if (type === 'lesson') modal.querySelector('[name="title"]').focus();
  }

  function taskMarkup(task, withActions) {
    var status = statusForTask(task);
    var subject = task.subjectId ? subjectName(task.subjectId) : '';
    return '<div class="task-row' + (task.status === 'Completed' && task.id === taskCompletionPulseId ? ' task-completion-pulse' : '') + '"><input class="check' + (task.status === 'Completed' && task.id === taskCompletionPulseId ? ' just-completed' : '') + '" type="checkbox" data-action="toggle-task" data-id="' + escapeHtml(task.id) + '" aria-label="Mark ' + escapeHtml(task.title) + ' completed"' + (task.status === 'Completed' ? ' checked' : '') + '>' +
      '<div class="task-main"><button class="text-button task-title' + (task.status === 'Completed' ? ' completed' : '') + '" data-action="edit-task" data-id="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + '</button>' +
      '<div class="task-meta"><span class="priority ' + priorityClass(task.priority) + '">' + escapeHtml(task.priority || 'Medium') + '</span>' +
      (task.dueTime ? '<span>' + escapeHtml(timeLabel(task.dueTime)) + '</span>' : '') +
      (subject ? '<span>' + escapeHtml(subject) + '</span>' : '') +
      (task.demo ? '<span class="status-pill">Demo</span>' : '') +
      '<span class="status-pill ' + statusClass(status) + '">' + escapeHtml(status) + '</span>' +
      (task.dueDate ? '<span>' + escapeHtml(dueHint(task)) + '</span>' : '') + '</div></div>' +
      (withActions ? '<div class="table-actions"><button class="icon-button" data-action="edit-task" data-id="' + escapeHtml(task.id) + '" aria-label="Edit task">✎</button><button class="icon-button" data-action="delete-task" data-id="' + escapeHtml(task.id) + '" aria-label="Delete task">×</button></div>' : '') + '</div>';
  }

  function emptyState(title, text, action, label) {
    var illustration = title === 'No subjects yet.' ? ' empty-subjects' :
      title.indexOf('No lessons') === 0 ? ' empty-lessons' :
        title === 'You’re all caught up.' ? ' empty-tasks' : '';
    return '<div class="empty-state' + illustration + '"><strong>' + escapeHtml(title) + '</strong>' + escapeHtml(text) + (action ? '<div style="margin-top:12px"><button class="button subtle" data-action="' + action + '">' + escapeHtml(label || 'Get started') + '</button></div>' : '') + '</div>';
  }

  function dayTasks(date) {
    return state.tasks.filter(function (task) { return task.dueDate === date; });
  }

  function todaysHabits() {
    return state.habits.filter(function (habit) { return habit.active !== 'Archived'; });
  }

  function habitDone(habitId, date) {
    return state.habitLogs.some(function (log) { return log.habitId === habitId && log.date === date; });
  }

  function completedStudyMinutes(dateStart, dateEnd) {
    var focusedMinutes = state.timer.completedSessions.reduce(function (sum, session) {
      if (session.phase !== 'focus' || !session.completedAt) return sum;
      var day = dateInConfiguredTimezone(new Date(session.completedAt));
      if (day < dateStart || day > dateEnd) return sum;
      return sum + Number(session.minutes || 0);
    }, 0);
    var plannedSessionMinutes = state.studySessions.reduce(function (sum, session) {
      if (session.status !== 'Completed' || !session.date || session.date < dateStart || session.date > dateEnd) return sum;
      return sum + Number(session.actualMinutes || 0);
    }, 0);
    return focusedMinutes + plannedSessionMinutes;
  }

  function renderDashboard() {
    var today = todayKey();
    var todays = dayTasks(today);
    var completed = todays.filter(function (task) { return task.status === 'Completed'; }).length;
    var remaining = todays.length - completed;
    var overdueTasks = state.tasks.filter(function (task) { return taskDeadlineState(task) === 'Overdue'; });
    var deadlinesToday = state.tasks.filter(function (task) { return taskDeadlineState(task) === 'Due Today'; });
    var upcoming = buildDeadlineRecords().filter(function (item) {
      return (item.kind === 'task' || item.kind === 'exam') &&
        (item.status === 'Due Tomorrow' || item.status === 'Due This Week');
    }).length;
    var habits = todaysHabits();
    var doneHabits = habits.filter(function (habit) { return habitDone(habit.id, today); }).length;
    var focusToday = completedStudyMinutes(today, today);
    var percent = todays.length ? Math.round(completed / todays.length * 100) : 0;
    var deadlines = buildDeadlineRecords().filter(function (item) {
      return item.status !== 'Completed' && item.days >= -1 && item.days <= 7;
    }).sort(function (a, b) { return a.dueAt - b.dueAt; }).slice(0, 5);
    var todayDay = parseDate(today).getDay();
    var schedule = state.schedule.filter(function (item) { return item.date === today; }).map(function (item) {
      return { id: item.id, kind: 'schedule', title: item.title, startTime: item.startTime, endTime: item.endTime, subject: subjectName(item.subjectId), location: '', action: 'edit-schedule' };
    }).concat(state.classSchedules.filter(function (item) { return classForDay(item, todayDay); }).map(function (item) {
      return { id: item.id, kind: 'class', title: item.subjectName, startTime: item.startTime, endTime: item.endTime, subject: item.subjectCode || '', location: item.location || '', action: 'edit-class' };
    })).sort(function (a, b) { return a.startTime.localeCompare(b.startTime); }).slice(0, 6);
    var currentTime = timeInConfiguredTimezone(new Date());
    var nextClassId = schedule.filter(function (item) { return item.kind === 'class' && item.startTime > currentTime; }).sort(function (a, b) { return a.startTime.localeCompare(b.startTime); }).map(function (item) { return item.id; })[0] || '';
    var highPriority = state.tasks.filter(function (task) {
      return task.status !== 'Completed' && (task.priority === 'High' || task.priority === 'Urgent');
    }).sort(function (a, b) {
      return priorityWeight(a.priority) - priorityWeight(b.priority) ||
        ((a.dueDate || '9999-99-99') + (a.dueTime || '')).localeCompare((b.dueDate || '9999-99-99') + (b.dueTime || ''));
    }).slice(0, 4);
    var upcomingEvents = buildDeadlineRecords().filter(function (item) {
      return item.kind !== 'task' && item.status !== 'Completed' && item.status !== 'Overdue' && item.days >= 0 && item.days <= 7;
    }).sort(function (a, b) { return a.dueAt - b.dueAt; }).slice(0, 4);
    var quoteList = [
      { text: 'Great things are done by a series of small things brought together.', author: 'Vincent van Gogh' },
      { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
      { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
      { text: 'Learning never exhausts the mind.', author: 'Leonardo da Vinci' }
    ];
    var todayDate = parseDate(today);
    var dayOfYear = Math.floor((Date.UTC(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()) - Date.UTC(todayDate.getFullYear(), 0, 1)) / 86400000);
    var quote = quoteList[(dayOfYear + state.quoteIndex) % quoteList.length];
    var notice = storageAvailable ? '<div class="notice info" style="margin-bottom:18px"><strong>Saved in this browser.</strong> No account is needed. Your data stays in this browser profile on this device; it is not uploaded or synced.</div>' :
      '<div class="notice error" style="margin-bottom:18px"><strong>Your data could not be saved.</strong> ' + escapeHtml(storageErrorMessage || 'Browser storage is unavailable.') + ' Keep this page open and export a backup before leaving if your unsaved changes are still visible.</div>';

    return notice +
      '<div class="welcome-row"><div><p class="eyebrow">Your overview</p><h1 class="greeting">' + currentTimeGreeting() + (state.preferences.name ? ', ' + escapeHtml(state.preferences.name) : '') + '</h1><p class="greeting-sub">Let’s make today productive.</p>' +
      '<div class="progress-line"><span>Daily progress</span><span class="progress-track"><span class="progress-fill" style="display:block;width:' + percent + '%"></span></span><span>' + percent + '%</span></div></div><div class="date-label">' + escapeHtml(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(parseDate(today))) + '</div></div>' +
      '<div class="dashboard-actions"><button class="button primary" data-action="add-task">＋ Add task</button><button class="button" data-action="add-class">＋ Add class</button><button class="button" data-action="add-schedule">＋ Add event</button><button class="button" data-action="add-study">＋ Add study session</button><button class="button" data-page-link="tasks">View all tasks →</button></div>' +
      '<section class="summary-grid">' +
      summaryCard('Tasks Today', completed + ' / ' + todays.length, remaining + ' remaining · ' + percent + '% complete', '☷') +
      summaryCard('Overdue', String(overdueTasks.length), 'Incomplete past deadlines', '!') +
      summaryCard('Due Today', String(deadlinesToday.length), 'Tasks requiring attention', '◷') +
      summaryCard('Coming Soon', String(upcoming), 'Deadlines in the next 7 days', '⌛') + '</section>' +
      '<section class="summary-strip"><span>Study time today <strong>' + formatMinutes(focusToday) + '</strong></span><span>Habits today <strong>' + doneHabits + ' / ' + habits.length + '</strong></span></section>' +
      '<div class="dashboard-grid"><div class="stack">' +
      '<section class="card' + (taskCompletionCelebration ? ' task-day-complete' : '') + '"><div class="card-title-row"><h2>Tasks due today</h2><button class="text-button" data-page-link="tasks">View all tasks</button></div>' +
      (todays.length ? '<div class="task-list">' + todays.sort(function (a, b) { return (a.dueTime || '').localeCompare(b.dueTime || ''); }).map(function (task) { return taskMarkup(task, false); }).join('') + '</div>' : emptyState('You’re all caught up.', 'Add a task to get started.', 'add-task', 'Add a task')) + '</section>' +
      (overdueTasks.length ? '<section class="card"><div class="card-title-row"><h2>Overdue tasks</h2><button class="text-button" data-page-link="deadlines">Review deadlines</button></div><div class="task-list">' + overdueTasks.slice(0, 4).map(function (task) { return taskMarkup(task, false); }).join('') + '</div></section>' : '') +
      '<section class="card"><div class="card-title-row"><h2>Today’s classes &amp; schedule</h2><button class="text-button" data-page-link="schedule">Open schedule</button></div>' +
      (schedule.length ? schedule.map(function (item) { return '<button class="schedule-row text-button w-100' + (item.id === nextClassId ? ' next-class-preview' : '') + '" data-action="' + item.action + '" data-id="' + escapeHtml(item.id) + '"><span class="summary-icon">' + (item.kind === 'class' ? '▤' : '◷') + '</span><div class="row-info"><strong>' + escapeHtml(item.title) + (item.id === nextClassId ? ' <span class="next-class-label">Next</span>' : '') + '</strong><small>' + escapeHtml(timeLabel(item.startTime)) + ' – ' + escapeHtml(timeLabel(item.endTime)) + (item.subject ? ' · ' + escapeHtml(item.subject) : '') + (item.location ? ' · ' + escapeHtml(item.location) : '') + '</small></div></button>'; }).join('') : emptyState('No classes or activities planned for today.', 'Add a recurring class or a dated schedule block.', 'add-class', 'Add Class Schedule')) + '</section></div>' +
      '<div class="stack"><section class="card"><div class="card-title-row"><h2>Upcoming deadlines</h2><span class="muted">Tasks &amp; exams</span></div>' +
      (deadlines.length ? deadlines.map(deadlineDashboardRow).join('') : emptyState('No upcoming deadlines.', 'You have a clear week ahead.')) +
      (upcomingEvents.length ? '<div class="card-title-row" style="margin-top:15px"><h3>Upcoming events</h3><button class="text-button" data-page-link="calendar">Calendar</button></div>' + upcomingEvents.map(deadlineDashboardRow).join('') : '') + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>High-priority tasks</h2><button class="text-button" data-page-link="tasks">All tasks</button></div>' +
      (highPriority.length ? highPriority.map(function (task) { return taskMarkup(task, false); }).join('') : emptyState('No high-priority tasks.', 'High and urgent incomplete tasks will show here.')) + '</section>' +
      '<section class="card quote-card"><div class="card-title-row"><h2>A little inspiration</h2><button class="icon-button quote-refresh" data-action="quote" aria-label="Show another quote" title="Show another quote">↻</button></div><p class="quote-text">“' + escapeHtml(quote.text) + '”</p><p class="quote-author">— ' + escapeHtml(quote.author) + '</p></section>' +
      timerWidget() + '</div></div>';
  }

  function deadlineDashboardRow(item) {
    var day = parseDate(item.date);
    var action = editActionForType(item.kind);
    return '<button class="deadline-row text-button w-100" data-action="' + action + '" data-id="' + escapeHtml(item.id) + '"><span class="deadline-date"><strong>' + escapeHtml(day.getDate()) + '</strong>' + escapeHtml(day.toLocaleDateString(undefined, { month: 'short' })) + '</span><span class="row-info"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(item.remaining) + (item.time ? ' · ' + escapeHtml(timeLabel(item.time)) : '') + (item.subject ? ' · ' + escapeHtml(item.subject) : '') + '</small></span><span class="status-pill ' + statusClass(item.status === 'Due Tomorrow' || item.status === 'Due This Week' ? 'Upcoming' : item.status) + '">' + escapeHtml(item.status) + '</span></button>';
  }

  function priorityWeight(value) {
    return ({ Urgent: 0, High: 1, Medium: 2, Low: 3 })[value] || 4;
  }

  function buildDeadlineRecords() {
    var groups = [
      { kind: 'task', collection: 'tasks', dateField: 'dueDate', timeField: 'dueTime' },
      { kind: 'exam', collection: 'exams', dateField: 'date', timeField: 'time' },
      { kind: 'event', collection: 'schedule', dateField: 'date', timeField: 'startTime' },
      { kind: 'study', collection: 'studySessions', dateField: 'date', timeField: 'startTime' }
    ];
    return groups.reduce(function (all, group) {
      return all.concat(state[group.collection].filter(function (item) {
        return item[group.dateField];
      }).map(function (item) {
        var date = item[group.dateField];
        var time = item[group.timeField] || '';
        var days = dayDifference(date);
        var done = item.status === 'Completed' || item.prepStatus === 'Completed';
        var status;
        if (done) status = 'Completed';
        else if (days < 0 || days === 0 && itemDueEpoch(item, group.collection) < Date.now()) status = 'Overdue';
        else if (days === 0) status = 'Due Today';
        else if (days === 1) status = 'Due Tomorrow';
        else if (days <= 7) status = 'Due This Week';
        else status = 'Upcoming';
        return {
          id: item.id,
          kind: group.kind,
          collection: group.collection,
          title: itemTitle(item, group.kind),
          date: date,
          time: time,
          dueAt: itemDueEpoch(item, group.collection),
          days: days,
          status: status,
          priority: item.priority || 'Medium',
          subjectId: item.subjectId || '',
          subject: subjectName(item.subjectId),
          category: item.category || (group.kind === 'exam' ? 'Exam' : group.kind === 'event' ? 'Event' : group.kind === 'study' ? 'Study' : 'Task'),
          description: item.description || item.topics || item.notes || '',
          remaining: remainingDeadline(item, group.collection)
        };
      }));
    }, []).sort(function (a, b) {
      if (a.status === 'Completed' && b.status !== 'Completed') return 1;
      if (b.status === 'Completed' && a.status !== 'Completed') return -1;
      return a.dueAt - b.dueAt;
    });
  }

  function editActionForType(type) {
    return type === 'task' ? 'edit-task' : type === 'exam' ? 'edit-exam' : type === 'event' ? 'edit-schedule' : 'edit-study';
  }

  function renderDeadlines() {
    var records = buildDeadlineRecords().filter(function (item) {
      if (deadlineFilters.type !== 'all' && item.kind !== deadlineFilters.type) return false;
      if (deadlineFilters.subject !== 'all' && item.subjectId !== deadlineFilters.subject) return false;
      if (deadlineFilters.priority !== 'all' && item.priority !== deadlineFilters.priority) return false;
      if (deadlineFilters.status === 'completed' && item.status !== 'Completed') return false;
      if (deadlineFilters.status === 'incomplete' && item.status === 'Completed') return false;
      if (deadlineFilters.status === 'overdue' && item.status !== 'Overdue') return false;
      if (deadlineFilters.status === 'today' && item.status !== 'Due Today') return false;
      if (deadlineFilters.status === 'tomorrow' && item.status !== 'Due Tomorrow') return false;
      if (deadlineFilters.status === 'week' && item.status !== 'Due This Week') return false;
      return true;
    });
    var groups = ['Overdue', 'Due Today', 'Due Tomorrow', 'Due This Week', 'Upcoming', 'Completed'];
    var grouped = groups.map(function (status) {
      var items = records.filter(function (item) { return item.status === status; });
      if (!items.length) return '';
      return '<section class="deadline-group"><h2 class="deadline-group-title"><span>' + status + '</span><span>' + items.length + '</span></h2>' +
        items.map(deadlineCard).join('') + '</section>';
    }).join('');
    var subjects = state.subjects.map(function (subject) { return '<option value="' + escapeHtml(subject.id) + '"' + (deadlineFilters.subject === subject.id ? ' selected' : '') + '>' + escapeHtml(subject.name) + '</option>'; }).join('');
    return pageHeading('Smart Deadlines', 'See what needs attention, sorted by the nearest due date.', '<button class="button" data-action="deadline-reset">Reset filters</button><button class="button primary" data-action="add-task">＋ Add deadline</button>') +
      '<div class="summary-grid">' + summaryCard('Overdue', String(records.filter(function (item) { return item.status === 'Overdue'; }).length), 'Incomplete past deadlines', '!') +
      summaryCard('Due Today', String(records.filter(function (item) { return item.status === 'Due Today'; }).length), 'Needs attention today', '◷') +
      summaryCard('Coming Soon', String(records.filter(function (item) { return ['Due Tomorrow', 'Due This Week', 'Upcoming'].includes(item.status); }).length), 'Future incomplete items', '⌛') +
      summaryCard('Completed', String(records.filter(function (item) { return item.status === 'Completed'; }).length), 'Completed items in this view', '✓') + '</div>' +
      '<section class="card"><div class="filter-grid">' +
      filterControl('Type', 'deadline-type', deadlineFilters.type, [['all', 'All types'], ['task', 'Tasks'], ['exam', 'Exams'], ['event', 'Events'], ['study', 'Study sessions']]) +
      filterControl('Subject', 'deadline-subject', deadlineFilters.subject, [['all', 'All subjects']].concat(state.subjects.map(function (subject) { return [subject.id, subject.name]; }))) +
      filterControl('Priority', 'deadline-priority', deadlineFilters.priority, [['all', 'All priorities'], ['Urgent', 'Urgent'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]) +
      filterControl('Completion', 'deadline-status', deadlineFilters.status, [['all', 'All statuses'], ['incomplete', 'Incomplete'], ['overdue', 'Overdue'], ['today', 'Due Today'], ['tomorrow', 'Due Tomorrow'], ['week', 'Due This Week'], ['completed', 'Completed']]) +
      '</div>' + (grouped || emptyState('No deadlines match these filters.', 'Try changing a filter or add an item with a due date.', 'deadline-reset', 'Reset filters')) + '</section>';
  }

  function filterControl(label, name, value, choices) {
    return '<label>' + label + '<select name="' + name + '">' + choices.map(function (option) {
      return '<option value="' + escapeHtml(option[0]) + '"' + (option[0] === value ? ' selected' : '') + '>' + escapeHtml(option[1]) + '</option>';
    }).join('') + '</select></label>';
  }

  function deadlineCard(item) {
    var dateText = dateLabel(item.date, { year: 'numeric', month: 'long', day: 'numeric' });
    var dateTime = dateText + (item.time ? ' · ' + timeLabel(item.time) : '');
    var action = editActionForType(item.kind);
    var finished = item.status === 'Completed';
    return '<article class="deadline-item' + (item.status === 'Overdue' ? ' overdue' : '') + (item.priority === 'Urgent' && !finished ? ' urgent' : '') + '">' +
      (item.kind === 'task' ? '<input class="check" type="checkbox" data-action="toggle-task" data-id="' + escapeHtml(item.id) + '" aria-label="Complete ' + escapeHtml(item.title) + '"' + (finished ? ' checked' : '') + '>' : '<span class="summary-icon">' + (item.kind === 'exam' ? '◇' : item.kind === 'event' ? '◷' : '◎') + '</span>') +
      '<div class="deadline-main"><button class="text-button deadline-title" data-action="' + action + '" data-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.title) + '</button><div class="deadline-detail"><span>' + escapeHtml(dateTime) + '</span><span>' + escapeHtml(item.remaining) + '</span><span>' + escapeHtml(item.subject || item.kind) + '</span><span class="priority ' + priorityClass(item.priority) + '">' + escapeHtml(item.priority) + '</span>' + (item.kind === 'task' ? '<span class="status-pill">' + escapeHtml(item.category) + '</span>' : '') + '</div></div>' +
      '<div class="deadline-controls"><span class="status-pill ' + statusClass(item.status === 'Due Tomorrow' || item.status === 'Due This Week' ? 'Upcoming' : item.status) + '">' + escapeHtml(item.status) + '</span><button class="icon-button" data-action="' + action + '" data-id="' + escapeHtml(item.id) + '" aria-label="Edit ' + escapeHtml(item.title) + '">✎</button></div></article>';
  }

  function searchableRecords() {
    var records = [];
    state.tasks.forEach(function (item) {
      records.push({ id: item.id, kind: 'task', collection: 'tasks', title: item.title, description: item.description || '', subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: item.priority || 'Medium', status: item.status === 'Completed' ? 'Completed' : taskDeadlineState(item), date: item.dueDate || '', time: item.dueTime || '', category: item.category || 'Task', action: 'edit-task' });
    });
    state.exams.forEach(function (item) {
      records.push({ id: item.id, kind: 'exam', collection: 'exams', title: item.title, description: [item.topics, item.notes].filter(Boolean).join(' '), subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: item.priority || 'Medium', status: item.prepStatus === 'Completed' ? 'Completed' : item.prepStatus || 'Scheduled', date: item.date || '', time: item.time || '', category: 'Exam', action: 'edit-exam' });
    });
    state.schedule.forEach(function (item) {
      records.push({ id: item.id, kind: 'event', collection: 'schedule', title: item.title, description: item.description || '', subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: 'Medium', status: 'Scheduled', date: item.date || '', time: item.startTime || '', category: item.category || 'Event', action: 'edit-schedule' });
    });
    state.classSchedules.forEach(function (item) {
      records.push({ id: item.id, kind: 'class', collection: 'classSchedules', title: item.subjectName, description: [item.subjectCode, item.instructor, item.location, item.notes, (item.days || []).join(' ')].filter(Boolean).join(' '), subjectId: '', subject: item.subjectName, priority: '', status: 'Recurring', date: '', time: item.startTime || '', category: 'Class', action: 'edit-class' });
    });
    state.studySessions.forEach(function (item) {
      records.push({ id: item.id, kind: 'study', collection: 'studySessions', title: item.topic, description: item.notes || '', subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: 'Medium', status: item.status || 'Planned', date: item.date || '', time: item.startTime || '', category: 'Study session', action: 'edit-study' });
    });
    state.subjects.forEach(function (item) {
      records.push({ id: item.id, kind: 'subject', collection: 'subjects', title: item.name, description: [item.code, item.instructor, item.period, item.description].filter(Boolean).join(' '), subjectId: item.id, subject: item.name, priority: '', status: '', date: '', time: '', category: 'Subject', action: 'edit-subject' });
    });
    state.flashcards.forEach(function (item) {
      records.push({ id: item.id, kind: 'reviewer', collection: 'flashcards', title: item.question, description: item.answer, subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: '', status: 'Saved', date: '', time: '', category: 'Reviewer', action: 'edit-flashcard' });
    });
    state.assessments.forEach(function (item) {
      records.push({ id: item.id, kind: 'assessment', collection: 'assessments', title: item.name, description: subjectName(item.subjectId) + ' ' + item.score + '/' + item.maximum, subjectId: item.subjectId || '', subject: subjectName(item.subjectId), priority: '', status: '', date: item.date || '', time: '', category: 'Assessment', action: 'edit-assessment' });
    });
    state.habits.forEach(function (item) {
      records.push({ id: item.id, kind: 'habit', collection: 'habits', title: item.name, description: item.description || '', subjectId: '', subject: '', priority: '', status: item.active || 'Active', date: '', time: '', category: 'Habit', action: 'edit-habit' });
    });
    return records;
  }

  function renderSearch() {
    var query = globalSearch.trim().toLowerCase();
    var results = searchableRecords().filter(function (item) {
      var text = [item.title, item.description, item.subject, item.category, item.status].join(' ').toLowerCase();
      if (query && !text.includes(query)) return false;
      if (searchFilters.type !== 'all' && item.kind !== searchFilters.type) return false;
      if (searchFilters.subject !== 'all' && item.subjectId !== searchFilters.subject) return false;
      if (searchFilters.priority !== 'all' && item.priority !== searchFilters.priority) return false;
      if (searchFilters.status === 'completed' && item.status !== 'Completed') return false;
      if (searchFilters.status === 'incomplete' && item.status === 'Completed') return false;
      if (searchFilters.status === 'high' && !['High', 'Urgent'].includes(item.priority)) return false;
      if (searchFilters.due !== 'all') {
        if (searchFilters.due === 'completed') return item.status === 'Completed';
        if (!item.date) return false;
        var days = dayDifference(item.date);
        if (searchFilters.due === 'today' && days !== 0) return false;
        if (searchFilters.due === 'upcoming' && (days <= 0 || item.status === 'Completed')) return false;
        if (searchFilters.due === 'overdue') {
          var record = getRecord(item.collection, item.id);
          var pastDue = days < 0 || days === 0 && record && itemDueEpoch(record, item.collection) < Date.now();
          if (!pastDue || item.status === 'Completed') return false;
        }
      }
      return true;
    }).sort(function (a, b) {
      return ((a.date || '9999-99-99') + (a.time || '')).localeCompare((b.date || '9999-99-99') + (b.time || ''));
    });
    return pageHeading('Search results', 'Search tasks, descriptions, subjects, exams, events, study sessions, grades, and habits.', '<button class="button" data-action="search-reset">Reset filters</button>') +
      '<section class="card"><div class="filter-grid">' +
      filterControl('Item type', 'search-type', searchFilters.type, [['all', 'All items'], ['task', 'Tasks'], ['class', 'Classes'], ['event', 'Events'], ['exam', 'Exams'], ['study', 'Study sessions'], ['subject', 'Subjects'], ['assessment', 'Assessments'], ['reviewer', 'Reviewers'], ['habit', 'Habits']]) +
      filterControl('Subject', 'search-subject', searchFilters.subject, [['all', 'All subjects']].concat(state.subjects.map(function (item) { return [item.id, item.name]; }))) +
      filterControl('Priority', 'search-priority', searchFilters.priority, [['all', 'All priorities'], ['Urgent', 'Urgent'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low']]) +
      filterControl('Status', 'search-status', searchFilters.status, [['all', 'All statuses'], ['incomplete', 'Incomplete'], ['completed', 'Completed'], ['high', 'High priority']]) +
      filterControl('Due date', 'search-due', searchFilters.due, [['all', 'Any date'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['overdue', 'Overdue'], ['completed', 'Completed']]) +
      '</div><div class="card-title-row"><h2>' + (query ? 'Matches for “' + escapeHtml(globalSearch.trim()) + '”' : 'All organizer items') + '</h2><span class="muted">' + results.length + ' results</span></div>' +
      (results.length ? results.map(function (item) { return '<article class="search-result"><div class="search-result-main"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(item.kind + ' · ' + (item.subject || item.category) + (item.date ? ' · ' + dateLabel(item.date) + (item.time ? ' at ' + timeLabel(item.time) : '') : '') + (item.description ? ' · ' + item.description : '')) + '</small></div><div><span class="search-type">' + escapeHtml(item.priority || item.status || item.kind) + '</span> <button class="icon-button" data-action="' + item.action + '" data-id="' + escapeHtml(item.id) + '" aria-label="Open ' + escapeHtml(item.title) + '">↗</button></div></article>'; }).join('') : emptyState('No matching items.', 'Try a different search or reset one or more filters.')) + '</section>';
  }

  function renderNotifications() {
    var items = state.notifications.filter(function (item) {
      return showDismissedNotifications || !item.dismissedAt;
    }).sort(function (a, b) {
      if (a.status === 'unread' && b.status !== 'unread') return -1;
      if (b.status === 'unread' && a.status !== 'unread') return 1;
      return (a.remindAt || 0) - (b.remindAt || 0);
    });
    var unread = state.notifications.filter(function (item) { return item.status === 'unread' && !item.dismissedAt; }).length;
    return pageHeading('Notifications', 'Scheduled reminders and recent alerts for your saved organizer items.', '<button class="button" data-action="notifications-read-all">Mark all read</button><button class="button" data-action="notifications-dismissed">' + (showDismissedNotifications ? 'Hide dismissed' : 'Show dismissed') + '</button>') +
      '<div class="notice info" style="margin-bottom:15px">In-app reminders and browser notifications are checked only while My PeOr is open. Browser notifications require permission and may be restricted by device settings. No service worker or server-side background push service is configured.</div>' +
      '<section class="card"><div class="card-title-row"><h2>Reminder center</h2><span class="status-pill">' + unread + ' unread</span></div>' +
      (items.length ? items.map(function (item) {
        var record = getRecord(itemCollectionForType(item.entityType), item.entityId);
        var typeName = item.entityType === 'event' ? 'schedule' : item.entityType;
        var dueMessage = item.status === 'scheduled' ? 'Reminder at ' + dateTimeLabel(new Date(item.remindAt).toISOString()) : item.status === 'unread' ? 'Reminder is due' : 'Reminder';
        return '<article class="notification-item' + (item.status === 'unread' ? ' unread' : '') + '"><span class="summary-icon">' + (item.status === 'scheduled' ? '◷' : '♧') + '</span><div class="notification-copy"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(dueMessage + ' · ' + (record ? itemTitle(record, typeName) : 'Item removed') + ' · deadline ' + dateTimeLabel(new Date(item.dueAt).toISOString())) + '</small></div><div class="notification-actions">' +
          (record ? '<button class="icon-button" data-action="' + editActionForType(typeName) + '" data-id="' + escapeHtml(item.entityId) + '" aria-label="Open reminder item">↗</button>' : '') +
          (item.status === 'unread' ? '<button class="icon-button" data-action="notification-read" data-id="' + escapeHtml(item.id) + '" aria-label="Mark as read">✓</button>' : '') +
          (!item.dismissedAt ? '<button class="icon-button" data-action="notification-dismiss" data-id="' + escapeHtml(item.id) + '" aria-label="Dismiss notification">×</button>' : '') +
          '</div></article>';
      }).join('') : emptyState('No notifications yet.', 'Choose reminder times on a task, event, exam, or study session.')) + '</section>';
  }
  function summaryCard(title, value, hint, icon) {
    return '<article class="summary-card"><div class="summary-top"><span>' + escapeHtml(title) + '</span><span class="summary-icon">' + icon + '</span></div><div class="summary-value">' + escapeHtml(value) + '</div><div class="summary-hint">' + escapeHtml(hint) + '</div></article>';
  }

  function formatMinutes(minutes) {
    var hours = Math.floor(minutes / 60);
    var rem = minutes % 60;
    return hours ? hours + 'h ' + rem + 'm' : rem + 'm';
  }

  function renderTasks() {
    var filtered = state.tasks.filter(function (task) {
      var status = statusForTask(task);
      var viewOk = taskView === 'all' ||
        (taskView === 'today' && task.dueDate === todayKey()) ||
        (taskView === 'upcoming' && task.dueDate && dayDifference(task.dueDate) > 0 && task.status !== 'Completed') ||
        (taskView === 'overdue' && status === 'Overdue') ||
        (taskView === 'completed' && task.status === 'Completed');
      return viewOk && (!taskSearch || task.title.toLowerCase().includes(taskSearch.toLowerCase())) &&
        (taskCategoryFilter === 'all' || task.category === taskCategoryFilter) &&
        (taskPriorityFilter === 'all' || task.priority === taskPriorityFilter);
    });
    filtered.sort(function (a, b) {
      if (taskSort === 'priority') {
        var rank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
        return rank[a.priority] - rank[b.priority];
      }
      if (taskSort === 'created') return (b.createdAt || '').localeCompare(a.createdAt || '');
      return ((a.dueDate || '9999-99-99') + (a.dueTime || '')).localeCompare((b.dueDate || '9999-99-99') + (b.dueTime || ''));
    });
    var tabs = [['all', 'All Tasks'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['overdue', 'Overdue'], ['completed', 'Completed']];
    return pageHeading('My Tasks', 'Capture, prioritize, and keep track of what matters.', '<button class="button primary" data-action="add-task">＋ Add Task</button>') +
      '<div class="segmented" style="margin-bottom:15px">' + tabs.map(function (tab) { return '<button data-action="task-view" data-value="' + tab[0] + '" class="' + (taskView === tab[0] ? 'selected' : '') + '">' + tab[1] + '</button>'; }).join('') + '</div>' +
      '<section class="card"><div class="toolbar"><input type="search" name="task-search" placeholder="Search tasks…" value="' + escapeHtml(taskSearch) + '" aria-label="Search tasks">' +
      '<select name="task-category" aria-label="Filter by category"><option value="all">All categories</option>' + ['Personal', 'School', 'Study', 'Project', 'Other'].map(function (item) { return '<option' + (taskCategoryFilter === item ? ' selected' : '') + '>' + item + '</option>'; }).join('') + '</select>' +
      '<select name="task-priority" aria-label="Filter by priority"><option value="all">All priorities</option>' + ['Low', 'Medium', 'High', 'Urgent'].map(function (item) { return '<option' + (taskPriorityFilter === item ? ' selected' : '') + '>' + item + '</option>'; }).join('') + '</select>' +
      '<select name="task-sort" aria-label="Sort tasks"><option value="due"' + (taskSort === 'due' ? ' selected' : '') + '>Sort: Due date</option><option value="priority"' + (taskSort === 'priority' ? ' selected' : '') + '>Sort: Priority</option><option value="created"' + (taskSort === 'created' ? ' selected' : '') + '>Sort: Created</option></select></div>' +
      (filtered.length ? '<div class="task-list">' + filtered.map(function (task) { return taskMarkup(task, true); }).join('') + '</div>' : emptyState('No tasks found.', 'Try another filter or add a new task.', 'add-task', 'Add a task')) + '</section>';
  }

  function pageHeading(title, subtitle, actions) {
    return '<div class="page-heading"><div><h1>' + title + '</h1><p>' + subtitle + '</p></div><div class="heading-actions">' + (actions || '') + '</div></div>';
  }

  function calendarEvents(date) {
    var key = typeof date === 'string' ? date : localDate(date);
    var result = [];
    state.tasks.filter(function (task) { return task.dueDate === key; }).forEach(function (task) {
      result.push({ id: task.id, kind: 'task', title: task.title, time: task.dueTime || '', type: 'task', status: task.status });
    });
    state.schedule.filter(function (item) { return item.date === key; }).forEach(function (item) {
      result.push({ id: item.id, kind: 'schedule', title: item.title, time: item.startTime, type: 'schedule' });
    });
    state.classSchedules.filter(function (item) {
      return classForDay(item, parseDate(key).getDay());
    }).forEach(function (item) {
      result.push({ id: item.id, kind: 'class', title: item.subjectName, time: item.startTime, type: 'schedule' });
    });
    state.exams.filter(function (item) { return item.date === key; }).forEach(function (item) {
      result.push({ id: item.id, kind: 'exam', title: item.title, time: item.time || '', type: 'exam' });
    });
    state.studySessions.filter(function (item) { return item.date === key; }).forEach(function (item) {
      result.push({ id: item.id, kind: 'study', title: item.topic, time: item.startTime || '', type: 'study' });
    });
    state.habitLogs.filter(function (item) { return item.date === key; }).forEach(function (item) {
      var habit = getRecord('habits', item.habitId);
      if (habit) result.push({ id: habit.id, kind: 'habit', title: habit.name, time: '', type: 'habit' });
    });
    return result.sort(function (a, b) { return a.time.localeCompare(b.time); });
  }

  function renderCalendar(integrated) {
    var year = calendarDate.getFullYear();
    var month = calendarDate.getMonth();
    var monthStart = new Date(year, month, 1);
    var gridStart = new Date(year, month, 1 - monthStart.getDay());
    var title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarDate);
    var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var cells = '';
    for (var i = 0; i < 42; i += 1) {
      var date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      var key = localDate(date);
      var events = calendarEvents(key);
      cells += '<button class="calendar-cell' + (date.getMonth() !== month ? ' outside' : '') + (key === todayKey() ? ' today' : '') + (key === selectedDate ? ' selected' : '') + '" data-action="select-date" data-date="' + key + '" aria-label="' + escapeHtml(date.toLocaleDateString()) + ', ' + events.length + ' activities"><span class="day-number">' + date.getDate() + '</span><span class="calendar-events">' + events.slice(0, 3).map(function (event) { return '<span class="calendar-event ' + event.type + '">' + escapeHtml((event.time ? timeLabel(event.time) + ' ' : '') + event.title) + '</span>'; }).join('') + (events.length > 3 ? '<span class="small-note">+' + (events.length - 3) + ' more</span>' : '') + '</span></button>';
    }
    var selected = calendarEvents(selectedDate);
    return (integrated ? '' : pageHeading('Calendar', 'Your tasks, exams, study sessions, and schedule in one view.', '<button class="button" data-action="calendar-today">Today</button><button class="button primary" data-action="add-calendar-item">＋ Add to date</button>')) +
      '<section class="card"><div class="calendar-top"><div class="heading-actions"><button class="icon-button" data-action="calendar-prev" aria-label="Previous month">‹</button><button class="icon-button" data-action="calendar-next" aria-label="Next month">›</button><strong class="calendar-title">' + escapeHtml(title) + '</strong><input type="date" name="calendar-date" aria-label="Select date" value="' + escapeHtml(selectedDate) + '" style="width:auto;min-height:32px;padding:5px 8px"></div><div class="segmented"><button class="' + (calendarView === 'month' ? 'selected' : '') + '" data-action="calendar-view" data-value="month">Month</button><button class="' + (calendarView === 'week' ? 'selected' : '') + '" data-action="calendar-view" data-value="week">Week</button><button class="' + (calendarView === 'day' ? 'selected' : '') + '" data-action="calendar-view" data-value="day">Day</button></div></div>' +
      (calendarView === 'month' ? '<div class="calendar-grid">' + days.map(function (day) { return '<div class="calendar-head">' + day + '</div>'; }).join('') + cells + '</div>' :
        renderCalendarList(calendarView)) + '</section>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Activities for ' + escapeHtml(dateLabel(selectedDate, { year: 'numeric' })) + '</h2><span class="muted">' + selected.length + ' items</span></div>' +
      (selected.length ? selected.map(calendarEventRow).join('') : emptyState('Nothing scheduled for this date.', 'Add a task or schedule block to plan ahead.', 'add-calendar-item', 'Add activity')) + '</section>';
  }

  function renderCalendarList(view) {
    var selected = parseDate(selectedDate) || new Date();
    var start = new Date(selected);
    if (view === 'week') start.setDate(start.getDate() - start.getDay());
    var count = view === 'week' ? 7 : 1;
    var output = '<div class="week-strip">' + Array.from({ length: count }, function (_, index) {
      var date = new Date(start); date.setDate(date.getDate() + index); var key = localDate(date);
      return '<button class="week-day' + (key === selectedDate ? ' selected' : '') + (key === todayKey() ? ' today' : '') + '" data-action="select-date" data-date="' + key + '">' + date.toLocaleDateString(undefined, { weekday: 'short' }) + '<strong>' + date.getDate() + '</strong></button>';
    }).join('') + '</div>';
    var selectedEvents = [];
    for (var i = 0; i < count; i += 1) {
      var day = new Date(start); day.setDate(day.getDate() + i);
      selectedEvents = selectedEvents.concat(calendarEvents(day).map(function (event) { event.date = localDate(day); return event; }));
    }
    if (!selectedEvents.length) return output + emptyState('No activities in this view.', 'Choose a date or add a new activity.');
    return output + '<div class="task-list">' + selectedEvents.map(function (event) { return '<div class="simple-row"><span class="deadline-date">' + escapeHtml(parseDate(event.date).getDate()) + '</span>' + calendarEventRow(event, true) + '</div>'; }).join('') + '</div>';
  }

  function calendarEventRow(event, hasDate) {
    var action = event.kind === 'task' ? 'edit-task' : event.kind === 'schedule' ? 'edit-schedule' : event.kind === 'class' ? 'edit-class' : event.kind === 'exam' ? 'edit-exam' : event.kind === 'habit' ? 'edit-habit' : 'edit-study';
    return '<button class="schedule-row text-button w-100" data-action="' + action + '" data-id="' + escapeHtml(event.id) + '"><span class="summary-icon">' + (event.kind === 'exam' ? '◇' : event.kind === 'class' ? '▤' : event.kind === 'schedule' ? '◷' : event.kind === 'study' ? '◎' : '☷') + '</span><span class="row-info"><strong>' + escapeHtml(event.title) + '</strong><small>' + escapeHtml(hasDate ? dateLabel(event.date) + ' · ' : '') + escapeHtml(event.time ? timeLabel(event.time) : event.kind) + '</small></span><span class="calendar-event ' + event.type + '">' + escapeHtml(event.kind) + '</span></button>';
  }

  function renderDatedSchedule(integrated) {
    var items = state.schedule.filter(function (item) { return item.date === selectedDate; }).sort(function (a, b) { return a.startTime.localeCompare(b.startTime); });
    var overlapIds = new Set();
    items.forEach(function (item, index) {
      items.slice(index + 1).forEach(function (other) {
        if (item.startTime < other.endTime && other.startTime < item.endTime) {
          overlapIds.add(item.id); overlapIds.add(other.id);
        }
      });
    });
    var now = new Date();
    var nowDate = todayKey();
    var currentTime = timeInConfiguredTimezone(now);
    var timeline = items.map(function (item) {
      var active = item.date === nowDate && currentTime >= item.startTime && currentTime < item.endTime;
      return '<div class="timeline-row"><div class="timeline-time">' + escapeHtml(timeLabel(item.startTime)) + '</div><div class="timeline-content"><div class="timeline-card"><strong>' + escapeHtml(item.title) + (active ? ' <span class="status-pill status-completed">Now</span>' : '') + '</strong><small>' + escapeHtml(timeLabel(item.startTime) + ' – ' + timeLabel(item.endTime)) + (item.subjectId ? ' · ' + escapeHtml(subjectName(item.subjectId)) : '') + ' · ' + escapeHtml(item.category) + '</small>' + (item.description ? '<small>' + escapeHtml(item.description) + '</small>' : '') +
      '<div class="table-actions"><button class="icon-button" data-action="edit-schedule" data-id="' + escapeHtml(item.id) + '" aria-label="Edit activity">✎</button><button class="icon-button" data-action="delete-schedule" data-id="' + escapeHtml(item.id) + '" aria-label="Delete activity">×</button></div>' +
      (overlapIds.has(item.id) ? '<small class="danger-text">This activity overlaps another schedule block.</small>' : '') + '</div></div></div>';
    }).join('');
    var dateObject = parseDate(selectedDate);
    return (integrated ? '' : pageHeading('Daily Schedule', 'Build a realistic routine and see how your day fits together.', '<button class="button" data-action="schedule-today">Today</button><button class="button primary" data-action="add-schedule">＋ Add block</button>')) +
      '<section class="card"><div class="calendar-top"><div class="heading-actions"><button class="icon-button" data-action="schedule-prev" aria-label="Previous day">‹</button><strong class="calendar-title">' + escapeHtml(dateObject.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + '</strong><button class="icon-button" data-action="schedule-next" aria-label="Next day">›</button><button class="button" data-action="schedule-today">Today</button></div><div class="heading-actions"><input style="width:auto" type="date" name="schedule-date" value="' + escapeHtml(selectedDate) + '" aria-label="Schedule date"><button class="button primary" data-action="add-schedule">＋ Add activity</button></div></div>' +
      '<div class="notice info" style="margin-bottom:14px">Schedule is stored locally. Overlapping activities are flagged so you can adjust them.</div>' +
      (items.length ? '<div class="timeline">' + timeline + '</div>' : emptyState('No schedule created for this day.', 'Plan classes, focused study, breaks, and personal time.', 'add-schedule', 'Add schedule block')) + '</section>';
  }

  function weekStartDate() {
    var date = parseDate(todayKey());
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + timetableWeekOffset * 7);
    return date;
  }

  function classForDay(classItem, day) {
    return (classItem.days || []).indexOf(String(day)) >= 0;
  }

  function timetableDayColumn(day, startHour, endHour, hideOtherDays) {
    var rangeStart = startHour * 60;
    var rangeEnd = endHour * 60;
    var items = state.classSchedules.filter(function (item) {
      return classForDay(item, day) && item.startTime < item.endTime &&
        Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3, 5)) > rangeStart &&
        Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3, 5)) < rangeEnd;
    }).sort(function (a, b) { return a.startTime.localeCompare(b.startTime); });
    var currentTime = timeInConfiguredTimezone(new Date());
    var nowMinutes = Number(currentTime.slice(0, 2)) * 60 + Number(currentTime.slice(3, 5));
    var isCurrentWeek = timetableWeekOffset === 0;
    var upcomingClassId = isCurrentWeek && day === parseDate(todayKey()).getDay()
      ? items.filter(function (item) { return Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3, 5)) > nowMinutes; }).map(function (item) { return item.id; })[0] || ''
      : '';
    var lanes = [];
    items.forEach(function (item) {
      var start = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3, 5));
      var end = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3, 5));
      var lane = 0;
      while (lanes[lane] && lanes[lane].some(function (other) { return start < other.end && other.start < end; })) lane += 1;
      if (!lanes[lane]) lanes[lane] = [];
      lanes[lane].push({ start: start, end: end, item: item });
    });
    var laneCount = Math.max(1, lanes.length);
    var height = (endHour - startHour) * 68;
    return '<div class="timetable-day-column' + (timetableDay === day ? ' selected' : '') + (hideOtherDays && timetableDay !== day ? ' hidden-day' : '') + '" data-weekday="' + day + '">' +
      '<div class="timetable-day-body" style="height:' + height + 'px">' + items.map(function (item) {
        var start = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3, 5));
        var end = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3, 5));
        var overlaps = items.some(function (other) { return other.id !== item.id && item.startTime < other.endTime && other.startTime < item.endTime; });
        var top = Math.max(0, (start - rangeStart) / 60 * 68);
        var blockHeight = Math.max(36, (Math.min(end, rangeEnd) - Math.max(start, rangeStart)) / 60 * 68 - 3);
        return '<article class="timetable-class' + (overlaps ? ' has-overlap' : '') + (item.id === upcomingClassId ? ' next-class' : '') + '" title="' + escapeHtml([item.instructor, item.notes].filter(Boolean).join(' · ')) + '" style="top:' + top + 'px;height:' + blockHeight + 'px;left:calc(' + (lanes.findIndex(function (lane) { return lane.some(function (entry) { return entry.item.id === item.id; }); }) * 100 / laneCount) + '% + 2px);width:calc(' + (100 / laneCount) + '% - 4px);--class-color:' + escapeHtml(/^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#5368d8') + '" data-action="edit-class" data-id="' + escapeHtml(item.id) + '">' +
          '<strong>' + escapeHtml(item.subjectName) + '</strong><small>' + escapeHtml(timeLabel(item.startTime) + '–' + timeLabel(item.endTime)) + '</small>' +
          (item.subjectCode ? '<small>' + escapeHtml(item.subjectCode) + '</small>' : '') +
          (item.location ? '<small>' + escapeHtml(item.location) + '</small>' : '') +
          (item.instructor ? '<small>' + escapeHtml(item.instructor) + '</small>' : '') +
          (overlaps ? '<span class="class-overlap-warning">Overlaps</span>' : '') +
          (item.id === upcomingClassId ? '<span class="next-class-label">Next</span>' : '') + '<span class="class-actions"><button data-action="edit-class" data-id="' + escapeHtml(item.id) + '" aria-label="Edit class schedule">✎</button><button data-action="delete-class" data-id="' + escapeHtml(item.id) + '" aria-label="Delete class schedule">×</button></span></article>';
      }).join('') + '</div></div>';
  }

  function renderWeeklyTimetable() {
    var startHour = Number(state.timetablePreferences.startHour);
    var endHour = Number(state.timetablePreferences.endHour);
    var mobileTimetable = window.matchMedia('(max-width: 780px)').matches;
    var weekStart = weekStartDate();
    var weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    var dayLabels = [1, 2, 3, 4, 5, 6, 0];
    var times = '';
    for (var hour = startHour; hour < endHour; hour += 1) {
      times += '<div class="timetable-hour-label">' + escapeHtml(timeLabel(String(hour).padStart(2, '0') + ':00')) + '</div>';
    }
    var dayColumns = dayLabels.map(function (day) {
      return timetableDayColumn(day, startHour, endHour, mobileTimetable || timetableView === 'day');
    }).join('');
    var mobileDay = timetableDayColumn(timetableDay, startHour, endHour, false);
    return '<section class="card timetable-card"><div class="calendar-top"><div class="heading-actions"><button class="icon-button" data-action="timetable-prev" aria-label="Previous week">‹</button><button class="button" data-action="timetable-today">This week</button><button class="icon-button" data-action="timetable-next" aria-label="Next week">›</button><strong class="calendar-title">' + escapeHtml(weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' – ' + weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })) + '</strong></div>' +
      '<div class="heading-actions timetable-settings"><label>From <select name="timetable-start">' + Array.from({ length: 24 }, function (_, index) { return '<option value="' + index + '"' + (index === startHour ? ' selected' : '') + '>' + escapeHtml(timeLabel(String(index).padStart(2, '0') + ':00')) + '</option>'; }).join('') + '</select></label>' +
      '<label>To <select name="timetable-end">' + Array.from({ length: 24 }, function (_, index) { var value = index + 1; return '<option value="' + value + '"' + (value === endHour ? ' selected' : '') + '>' + escapeHtml(timeLabel(String(value % 24).padStart(2, '0') + ':00')) + '</option>'; }).join('') + '</select></label></div></div>' +
      '<div class="timetable-view-toggle segmented"><button data-action="timetable-view" data-value="week" class="' + (timetableView === 'week' ? 'selected' : '') + '">Week</button><button data-action="timetable-view" data-value="day" class="' + (timetableView === 'day' ? 'selected' : '') + '">Day</button></div>' +
      (timetableView === 'day' || mobileTimetable ? '<div class="timetable-day-picker">' + dayLabels.map(function (day) { return '<button class="' + (timetableDay === day ? 'selected' : '') + '" data-action="timetable-day" data-day="' + day + '">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] + '</button>'; }).join('') + '</div>' : '') +
      (state.classSchedules.length ? '<div class="timetable-grid' + (timetableView === 'day' ? ' day-view' : mobileTimetable ? ' mobile-day-view' : '') + '" style="--timetable-hours:' + (endHour - startHour) + '">' +
        '<div class="timetable-corner"></div>' + dayLabels.map(function (day) { var date = new Date(weekStart); date.setDate(date.getDate() + ((day + 6) % 7)); return '<button class="timetable-heading' + ((timetableView === 'day' || mobileTimetable) && day !== timetableDay ? ' hidden-day' : '') + '" data-action="timetable-day" data-day="' + day + '"><strong>' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day] + '</strong><span>' + date.getDate() + '</span></button>'; }).join('') +
        '<div class="timetable-axis">' + times + '</div>' + (timetableView === 'day' ? mobileDay : dayColumns) + '</div>' :
        emptyState('Your weekly timetable is empty.', 'Add recurring class times to see your week at a glance.', 'add-class', 'Add Class Schedule')) + '</section>';
  }

  function renderSchedule() {
    var tabs = '<div class="page-tabs" role="tablist" aria-label="Schedule sections">' +
      [['timetable', 'Weekly Timetable'], ['calendar', 'Calendar'], ['exams', 'Exams & Study Sessions']].map(function (tab) {
        return '<button role="tab" aria-selected="' + (scheduleTab === tab[0]) + '" class="' + (scheduleTab === tab[0] ? 'selected' : '') + '" data-action="schedule-tab" data-value="' + tab[0] + '">' + tab[1] + '</button>';
      }).join('') + '</div>';
    var content = scheduleTab === 'timetable' ? renderWeeklyTimetable() :
      scheduleTab === 'calendar' ? renderCalendar(true) + renderDatedSchedule(true) : renderPlanner();
    return pageHeading('My Schedule', 'Plan recurring classes, dated events, exams, and study sessions.', '<button class="button primary" data-action="' + (scheduleTab === 'timetable' ? 'add-class' : scheduleTab === 'calendar' ? 'add-calendar-item' : 'add-exam') + '">' + (scheduleTab === 'timetable' ? '＋ Add Class Schedule' : scheduleTab === 'calendar' ? '＋ Add event' : '＋ Add exam') + '</button>') + tabs + content;
  }

  function renderSubjects(integrated) {
    var assessments = state.assessments.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var subjectCards = state.subjects.map(function (subject) {
      var records = assessments.filter(function (item) { return item.subjectId === subject.id; });
      var upcomingExams = state.exams.filter(function (exam) { return exam.subjectId === subject.id && dayDifference(exam.date) >= 0; }).sort(function (a, b) { return a.date.localeCompare(b.date); }).slice(0, 3);
      var relatedClasses = state.classSchedules.filter(function (item) { return item.subjectId === subject.id || item.subjectName.trim().toLowerCase() === subject.name.trim().toLowerCase(); });
      var avg = records.length ? records.reduce(function (sum, item) { return sum + item.score / item.maximum * 100; }, 0) / records.length : null;
      var weightedRecords = records.filter(function (item) { return item.weight !== '' && item.weight != null && Number(item.weight) > 0; });
      var weightTotal = weightedRecords.reduce(function (sum, item) { return sum + Number(item.weight); }, 0);
      var allHaveWeights = records.length > 0 && weightedRecords.length === records.length;
      var weighted = allHaveWeights && Math.abs(weightTotal - 100) < .001 ? weightedRecords.reduce(function (sum, item) { return sum + item.score / item.maximum * Number(item.weight); }, 0) / 100 : null;
      var gradeDisplay = avg == null ? 'No grades recorded yet' : 'Recorded average: ' + avg.toFixed(1) + '%';
      var weightingNote = weighted == null ? (weightedRecords.length ? '<p class="small-note">Weighted estimate unavailable: recorded weights total ' + weightTotal + '%, not 100%.</p>' : '<p class="small-note">No configured weights; average is an unweighted percentage.</p>') : '<p class="small-note">Weighted estimate: ' + weighted.toFixed(1) + '% (weights total 100%).</p>';
      return '<article class="card"><div class="card-title-row"><h3>' + escapeHtml(subject.name) + '</h3><div class="table-actions"><button class="icon-button" data-action="edit-subject" data-id="' + escapeHtml(subject.id) + '" aria-label="Edit subject">✎</button><button class="icon-button" data-action="delete-subject" data-id="' + escapeHtml(subject.id) + '" aria-label="Delete subject">×</button></div></div>' +
        '<p class="small-note">' + escapeHtml([subject.code, subject.instructor, subject.period].filter(Boolean).join(' · ') || 'Subject details can be added in edit.') + '</p><div class="inline-stat"><strong>' + (avg == null ? '—' : avg.toFixed(1) + '%') + '</strong><span class="muted">' + gradeDisplay + '</span></div>' + weightingNote +
        ((upcomingExams.length || relatedClasses.length) ? '<div class="related-academic"><strong>Upcoming &amp; schedule</strong>' + upcomingExams.map(function (exam) { return '<button class="text-button" data-action="edit-exam" data-id="' + escapeHtml(exam.id) + '">' + escapeHtml(exam.title + ' · ' + dateLabel(exam.date) + (exam.time ? ' · ' + timeLabel(exam.time) : '')) + '</button>'; }).join('') + relatedClasses.map(function (item) { return '<button class="text-button" data-action="edit-class" data-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.subjectName + ' · ' + (item.days || []).map(function (day) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(day)]; }).join(', ') + ' · ' + timeLabel(item.startTime)) + '</button>'; }).join('') + '</div>' : '') +
        '<button class="text-button" data-action="add-assessment" data-subject="' + escapeHtml(subject.id) + '">＋ Record assessment</button>' +
        (records.length ? '<div class="task-list" style="margin-top:10px">' + records.slice(0, 4).map(assessmentRow).join('') + '</div>' : '') + '</article>';
    }).join('');
    return (integrated ? '<div class="notice info lesson-academics-link">Organize course notes and learning materials by subject in <button class="text-button" data-page-link="lessons">Lesson Organizer →</button></div>' : pageHeading('Subjects & Grades', 'Keep subjects, assessments, and recorded scores together.', '<button class="button" data-action="add-assessment">＋ Record grade</button><button class="button primary" data-action="add-subject">＋ Add subject</button>')) +
      (!state.subjects.length ? emptyState('No subjects yet.', 'Create your first subject to organize your academic progress.', 'add-subject', 'Add a subject') : '<div class="section-grid">' + subjectCards + '</div>') +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Assessment records</h2><span class="muted">' + assessments.length + ' recorded</span></div>' +
      (assessments.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Assessment</th><th>Subject</th><th>Score</th><th>Percentage</th><th>Date</th><th></th></tr></thead><tbody>' + assessments.map(function (item) { return '<tr><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(subjectName(item.subjectId) || '—') + '</td><td>' + escapeHtml(item.score) + ' / ' + escapeHtml(item.maximum) + '</td><td>' + (item.maximum ? (item.score / item.maximum * 100).toFixed(1) + '%' : '—') + '</td><td>' + escapeHtml(dateLabel(item.date)) + '</td><td><div class="table-actions"><button class="icon-button" data-action="edit-assessment" data-id="' + escapeHtml(item.id) + '" aria-label="Edit assessment">✎</button><button class="icon-button" data-action="delete-assessment" data-id="' + escapeHtml(item.id) + '" aria-label="Delete assessment">×</button></div></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No grades recorded yet.', 'Add an assessment to begin tracking scores.')) + '</section>';
  }

  function assessmentRow(item) {
    return '<div class="simple-row"><span class="row-info"><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(dateLabel(item.date)) + ' · ' + escapeHtml(item.score) + '/' + escapeHtml(item.maximum) + '</small></span><span class="status-pill">' + (item.maximum ? (item.score / item.maximum * 100).toFixed(0) + '%' : '—') + '</span></div>';
  }

  function renderPlanner(integrated) {
    var exams = state.exams.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var sessions = state.studySessions.slice().sort(function (a, b) { return (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')); });
    return (integrated ? '' : pageHeading('Exams & Study Planner', 'Prepare across the semester with manageable study sessions.', '<button class="button" data-action="add-study">＋ Plan study</button><button class="button primary" data-action="add-exam">＋ Add exam</button>')) +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Upcoming exams</h2><span class="muted">' + exams.filter(function (exam) { return dayDifference(exam.date) >= 0; }).length + ' upcoming</span></div>' +
      (exams.length ? exams.map(function (exam) { var days = dayDifference(exam.date); return '<div class="simple-row"><span class="deadline-date"><strong>' + escapeHtml(parseDate(exam.date).getDate()) + '</strong>' + escapeHtml(parseDate(exam.date).toLocaleDateString(undefined, { month: 'short' })) + '</span><span class="row-info"><strong>' + escapeHtml(exam.title) + (exam.demo ? ' · Demo' : '') + '</strong><small>' + escapeHtml(subjectName(exam.subjectId) || 'No subject') + (exam.time ? ' · ' + escapeHtml(timeLabel(exam.time)) : '') + ' · ' + escapeHtml(days < 0 ? 'Past' : days === 0 ? 'Today' : 'In ' + days + ' days') + '</small></span><span class="status-pill">' + escapeHtml(exam.prepStatus) + '</span><span class="table-actions"><button class="icon-button" data-action="edit-exam" data-id="' + escapeHtml(exam.id) + '" aria-label="Edit exam">✎</button><button class="icon-button" data-action="delete-exam" data-id="' + escapeHtml(exam.id) + '" aria-label="Delete exam">×</button></span></div>'; }).join('') : emptyState('No exams scheduled yet.', 'Add your next quiz or examination.', 'add-exam', 'Add an exam')) + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>Focus timer</h2><span class="muted">Pomodoro</span></div>' + timerWidget(true) + '<button class="text-button" data-action="open-settings">Adjust focus and break durations in Settings</button></section></div>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Planned study sessions</h2><button class="button" data-action="add-study">＋ Plan session</button></div>' +
      (sessions.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Topic</th><th>Subject</th><th>Date &amp; time</th><th>Planned</th><th>Status</th><th></th></tr></thead><tbody>' + sessions.map(function (session) { return '<tr><td>' + escapeHtml(session.topic) + '<div class="small-note">' + escapeHtml(session.notes || '') + '</div></td><td>' + escapeHtml(subjectName(session.subjectId) || '—') + '</td><td>' + escapeHtml(dateLabel(session.date)) + (session.startTime ? ' · ' + escapeHtml(timeLabel(session.startTime)) : '') + '</td><td>' + escapeHtml(session.plannedMinutes || 0) + ' min' + (session.actualMinutes ? ' · ' + escapeHtml(session.actualMinutes) + ' actual' : '') + '</td><td><span class="status-pill ' + (session.status === 'Completed' ? 'status-completed' : 'status-upcoming') + '">' + escapeHtml(session.status) + '</span></td><td><div class="table-actions"><button class="icon-button" data-action="toggle-study" data-id="' + escapeHtml(session.id) + '" aria-label="Toggle study completion">' + (session.status === 'Completed' ? '↶' : '✓') + '</button><button class="icon-button" data-action="edit-study" data-id="' + escapeHtml(session.id) + '" aria-label="Edit session">✎</button><button class="icon-button" data-action="delete-study" data-id="' + escapeHtml(session.id) + '" aria-label="Delete session">×</button></div></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No study sessions planned.', 'Plan your first focused session across the days before an exam.', 'add-study', 'Plan a study session')) + '</section>';
  }

  function renderFlashcards() {
    return '<section class="card"><div class="card-title-row"><div><h2>Study reviewers</h2><p class="small-note">Create your own question-and-answer flashcards.</p></div><button class="button primary" data-action="add-flashcard">＋ Add flashcard</button></div>' +
      (state.flashcards.length ? '<div class="flashcard-list">' + state.flashcards.map(function (item) {
        var revealed = revealedFlashcards.has(item.id);
        return '<article class="flashcard"><div class="flashcard-question"><span class="eyebrow">' + escapeHtml(subjectName(item.subjectId) || 'Unassigned') + '</span><strong>' + escapeHtml(item.question) + '</strong>' +
          (revealed ? '<p>' + escapeHtml(item.answer) + '</p>' : '') + '</div><div class="table-actions"><button class="button" data-action="flashcard-reveal" data-id="' + escapeHtml(item.id) + '">' + (revealed ? 'Hide answer' : 'Show answer') + '</button><button class="icon-button" data-action="edit-flashcard" data-id="' + escapeHtml(item.id) + '" aria-label="Edit flashcard">✎</button><button class="icon-button" data-action="delete-flashcard" data-id="' + escapeHtml(item.id) + '" aria-label="Delete flashcard">×</button></div></article>';
      }).join('') + '</div>' : emptyState('No reviewers yet.', 'Add a flashcard to start creating your own study reviewer.', 'add-flashcard', 'Add flashcard')) + '</section>';
  }

  function renderAcademics() {
    var tabs = [['subjects', 'Subjects & Grades'], ['planner', 'Exams & Study Planner'], ['reviewers', 'Reviewers']];
    var content = academicsTab === 'subjects' ? renderSubjects(true) : academicsTab === 'planner' ? renderPlanner(true) : renderFlashcards();
    var action = academicsTab === 'subjects' ? '<button class="button" data-action="add-assessment">＋ Record grade</button><button class="button primary" data-action="add-subject">＋ Add subject</button>' :
      academicsTab === 'planner' ? '<button class="button" data-action="add-study">＋ Plan study</button><button class="button primary" data-action="add-exam">＋ Add exam</button>' :
        '<button class="button primary" data-action="add-flashcard">＋ Add flashcard</button>';
    return pageHeading('Academics', 'Manage subjects, grades, exams, study plans, and your own reviewers.', action) +
      '<div class="page-tabs" role="tablist" aria-label="Academic sections">' + tabs.map(function (tab) {
        return '<button role="tab" aria-selected="' + (academicsTab === tab[0]) + '" class="' + (academicsTab === tab[0] ? 'selected' : '') + '" data-action="academics-tab" data-value="' + tab[0] + '">' + tab[1] + '</button>';
      }).join('') + '</div>' + content;
  }

  function lessonFolderCounts(subjectId) {
    return {
      lessons: state.lessons.filter(function (item) { return item.subjectId === subjectId; }).length,
      files: state.lessonAttachments.filter(function (item) { return item.subjectId === subjectId; }).length
    };
  }

  function formatFileSize(size) {
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function attachmentType(file) {
    var extension = String(file.name || '').split('.').pop().toUpperCase();
    return extension && extension !== file.name.toUpperCase() ? extension : (file.type || 'File');
  }

  function attachmentIconLabel(file) {
    return file.type === 'application/pdf' ? 'PDF' : /^image\//i.test(file.type || '') ? 'IMG' : attachmentType(file).slice(0, 3);
  }

  function lessonNotesMarkup(notes) {
    var lines = escapeHtml(notes || '').split(/\r?\n/);
    var output = [];
    var list = [];
    function inline(text) {
      return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    }
    function flushList() {
      if (!list.length) return;
      output.push('<ul>' + list.map(function (line) { return '<li>' + inline(line) + '</li>'; }).join('') + '</ul>');
      list = [];
    }
    lines.forEach(function (line) {
      var bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bullet) list.push(bullet[1]);
      else {
        flushList();
        if (line) output.push('<p>' + inline(line) + '</p>');
        else output.push('<br>');
      }
    });
    flushList();
    return output.join('');
  }

  function lessonAttachmentMarkup(file, showOwner) {
    var lesson = file.lessonId ? getRecord('lessons', file.lessonId) : null;
    var previewable = file.type === 'application/pdf' || /^image\/(jpeg|png|gif|webp|bmp)$/i.test(file.type || '');
    return '<div class="lesson-file-row"><span class="lesson-file-icon" aria-hidden="true">' + escapeHtml(attachmentIconLabel(file)) + '</span><span class="lesson-file-info"><strong title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</strong><small>' + escapeHtml(attachmentType(file)) + ' · ' + escapeHtml(formatFileSize(Number(file.size) || 0)) + (showOwner ? ' · ' + escapeHtml(lesson ? lesson.title : 'Subject files') : '') + '</small></span><span class="table-actions"><button class="button" data-action="' + (previewable ? 'attachment-open' : 'attachment-download') + '" data-id="' + escapeHtml(file.id) + '">' + (previewable ? 'Open' : 'Download') + '</button><button class="icon-button" data-action="attachment-download" data-id="' + escapeHtml(file.id) + '" aria-label="Download ' + escapeHtml(file.name) + '">↓</button><button class="icon-button" data-action="attachment-replace" data-id="' + escapeHtml(file.id) + '" aria-label="Replace ' + escapeHtml(file.name) + '">↻</button><button class="icon-button" data-action="attachment-delete" data-id="' + escapeHtml(file.id) + '" aria-label="Delete ' + escapeHtml(file.name) + '">×</button></span></div>';
  }

  function renderLessonOrganizer() {
    var subjects = state.subjects.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var subject = lessonSubjectId ? getRecord('subjects', lessonSubjectId) : null;
    if (lessonSubjectId && !subject) lessonSubjectId = '';
    if (!subject) {
      var cards = subjects.map(function (item) {
        var counts = lessonFolderCounts(item.id);
        var color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#5368d8';
        return '<article class="card lesson-folder-card" style="--lesson-enter-delay:' + Math.min(subjects.indexOf(item), 5) * 45 + 'ms"><div class="lesson-folder-top"><button class="lesson-folder-icon" data-action="lesson-open-subject" data-id="' + escapeHtml(item.id) + '" aria-label="Open ' + escapeHtml(item.name) + '" style="--folder-color:' + color + '">' + escapeHtml(item.icon || '▧') + '</button><div class="table-actions"><button class="icon-button" data-action="edit-subject" data-id="' + escapeHtml(item.id) + '" aria-label="Edit ' + escapeHtml(item.name) + '">✎</button><button class="icon-button" data-action="delete-subject" data-id="' + escapeHtml(item.id) + '" aria-label="Delete ' + escapeHtml(item.name) + '">×</button></div></div><button class="lesson-folder-name text-button" data-action="lesson-open-subject" data-id="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</button><p class="small-note">' + escapeHtml([item.code, item.description].filter(Boolean).join(' · ') || 'Open this folder to add lessons and files.') + '</p><div class="lesson-folder-counts"><span>' + counts.lessons + ' ' + (counts.lessons === 1 ? 'lesson' : 'lessons') + '</span><span>' + counts.files + ' ' + (counts.files === 1 ? 'file' : 'files') + '</span></div></article>';
      }).join('');
      return pageHeading('Lesson Organizer', 'Keep your lesson notes and learning materials together by subject.', '<button class="button primary" data-action="add-subject">＋ Add Subject</button>') +
        '<div class="notice info lesson-storage-notice">Lessons and files are saved locally in this browser (15 MB per file, 50 MB total). Clearing browser site data may permanently remove them. Export a backup in Settings to keep a copy.</div>' +
        (subjects.length ? '<div class="lesson-folder-grid">' + cards + '</div>' : emptyState('No subject folders yet.', 'Create a subject folder to start organizing your lessons.', 'add-subject', 'Add Subject'));
    }

    var lessons = state.lessons.filter(function (item) {
      if (item.subjectId !== subject.id) return false;
      if (lessonStatusFilter === 'reviewed' && item.reviewStatus !== 'Reviewed') return false;
      if (lessonStatusFilter === 'unreviewed' && item.reviewStatus === 'Reviewed') return false;
      var text = [item.title, item.topic, item.notes, item.lessonNumber].join(' ').toLowerCase();
      return !lessonSearch || text.indexOf(lessonSearch.toLowerCase()) >= 0;
    });
    lessons.sort(function (a, b) {
      if (lessonSort === 'title') return a.title.localeCompare(b.title);
      if (lessonSort === 'date') return (a.date || '9999').localeCompare(b.date || '9999');
      return (Number(a.order) || Number(a.lessonNumber) || 0) - (Number(b.order) || Number(b.lessonNumber) || 0);
    });
    var lessonCards = lessons.map(function (item, index) {
      var fileRows = state.lessonAttachments.filter(function (file) { return file.lessonId === item.id; }).map(function (file) { return lessonAttachmentMarkup(file, false); }).join('');
      var reorderDisabled = lessonSort !== 'order' || lessonStatusFilter !== 'all' || Boolean(lessonSearch);
      return '<article class="card lesson-card" style="--lesson-enter-delay:' + Math.min(index, 5) * 45 + 'ms"><div class="lesson-card-heading"><span class="lesson-number">' + escapeHtml(item.lessonNumber || index + 1) + '</span><div class="lesson-card-title"><h3>' + escapeHtml(item.title) + '</h3><p class="small-note">' + escapeHtml([item.topic, item.date ? dateLabel(item.date) : ''].filter(Boolean).join(' · ') || 'Lesson details') + '</p></div><span class="status-pill ' + (item.reviewStatus === 'Reviewed' ? 'status-completed' : 'status-upcoming') + '">' + escapeHtml(item.reviewStatus || 'Not Reviewed') + '</span></div>' +
        (item.notes ? '<div class="lesson-notes">' + lessonNotesMarkup(item.notes) + '</div>' : '') +
        (fileRows ? '<div class="lesson-files">' + fileRows + '</div>' : '') +
        '<div class="lesson-card-actions"><button class="button" data-action="lesson-upload-files" data-subject="' + escapeHtml(subject.id) + '" data-lesson="' + escapeHtml(item.id) + '">＋ Upload Files</button><button class="button" data-action="lesson-toggle-reviewed" data-id="' + escapeHtml(item.id) + '">' + (item.reviewStatus === 'Reviewed' ? 'Mark not reviewed' : 'Mark reviewed') + '</button><button class="icon-button" data-action="lesson-move" data-id="' + escapeHtml(item.id) + '" data-direction="up" aria-label="Move lesson up" ' + (reorderDisabled || index === 0 ? 'disabled' : '') + '>↑</button><button class="icon-button" data-action="lesson-move" data-id="' + escapeHtml(item.id) + '" data-direction="down" aria-label="Move lesson down" ' + (reorderDisabled || index === lessons.length - 1 ? 'disabled' : '') + '>↓</button><button class="icon-button" data-action="lesson-edit" data-id="' + escapeHtml(item.id) + '" aria-label="Edit lesson">✎</button><button class="icon-button" data-action="lesson-delete" data-id="' + escapeHtml(item.id) + '" aria-label="Delete lesson">×</button></div></article>';
    }).join('');
    var subjectFiles = state.lessonAttachments.filter(function (file) { return file.subjectId === subject.id && !file.lessonId; });
    return pageHeading(subject.name, [subject.code, subject.description].filter(Boolean).join(' · ') || 'Lessons, notes, and materials for this subject.', '<button class="button" data-action="lesson-back">‹ All subjects</button><button class="button" data-action="lesson-upload-files" data-subject="' + escapeHtml(subject.id) + '">＋ Upload Files</button><button class="button primary" data-action="lesson-add" data-subject="' + escapeHtml(subject.id) + '">＋ Add Lesson</button>') +
      '<div class="toolbar lesson-toolbar"><input type="search" name="lesson-search" placeholder="Search lessons and notes…" value="' + escapeHtml(lessonSearch) + '" aria-label="Search lessons"><select name="lesson-status" aria-label="Filter by review status"><option value="all"' + (lessonStatusFilter === 'all' ? ' selected' : '') + '>All lessons</option><option value="reviewed"' + (lessonStatusFilter === 'reviewed' ? ' selected' : '') + '>Reviewed</option><option value="unreviewed"' + (lessonStatusFilter === 'unreviewed' ? ' selected' : '') + '>Not reviewed</option></select><select name="lesson-sort" aria-label="Sort lessons"><option value="order"' + (lessonSort === 'order' ? ' selected' : '') + '>Lesson order</option><option value="title"' + (lessonSort === 'title' ? ' selected' : '') + '>Title</option><option value="date"' + (lessonSort === 'date' ? ' selected' : '') + '>Date</option></select><button class="button" data-action="lesson-clear-search">Clear search</button></div>' +
      (lessons.length ? '<div class="lesson-list">' + lessonCards + '</div>' : emptyState(lessonSearch || lessonStatusFilter !== 'all' ? 'No matching lessons.' : 'No lessons in this subject yet.', lessonSearch || lessonStatusFilter !== 'all' ? 'Try changing your search or review filter.' : 'Add a lesson or upload subject materials to get started.', 'lesson-add', 'Add Lesson')) +
      (subjectFiles.length ? '<section class="card lesson-subject-files"><div class="card-title-row"><div><h2>Subject files</h2><p class="small-note">Materials attached to this subject rather than a specific lesson.</p></div></div><div class="lesson-files">' + subjectFiles.map(function (file) { return lessonAttachmentMarkup(file, false); }).join('') + '</div></section>' : '') +
      '<p class="small-note lesson-storage-footnote">' + lessonFolderCounts(subject.id).files + ' attached files · Stored only on this device. File availability depends on this browser’s remaining storage capacity.</p>';
  }

  function timerWidget(compact) {
    var timer = state.timer;
    var duration = timer.phase === 'focus' ? state.preferences.focusMinutes : timer.phase === 'shortBreak' ? state.preferences.shortBreakMinutes : state.preferences.longBreakMinutes;
    var remaining = timer.status === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remainingMs;
    var total = Math.max(1, duration * 60000);
    var progress = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
    var label = timer.phase === 'focus' ? 'Focus session' : timer.phase === 'shortBreak' ? 'Short break' : 'Long break';
    var min = Math.floor(remaining / 60000).toString().padStart(2, '0');
    var sec = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
    return '<div class="timer-card' + (compact ? ' compact' : '') + (timerPhaseChanged ? ' timer-phase-change' : '') + '"><div class="timer-ring" style="--timer-progress:' + progress + '%"><div class="timer-inner"><span class="timer-label">' + label + '</span><strong class="timer-time">' + min + ':' + sec + '</strong></div></div>' +
      (timer.recoveredExpired ? '<p class="small-note danger-text">The timer expired while the page was away. It was not counted as a completed session.</p>' : '') +
      '<p class="small-note">Completed focus sessions: ' + timer.focusCount + '</p><div class="timer-actions">' +
      (timer.status === 'running' ? '<button class="button" data-action="timer-pause">Pause</button>' : '<button class="button primary" data-action="timer-start">' + (timer.status === 'paused' ? 'Resume' : 'Start') + '</button>') +
      '<button class="button" data-action="timer-reset">Reset</button><button class="button" data-action="timer-skip">Skip</button></div></div>';
  }

  function renderHabits(integrated) {
    var habits = todaysHabits();
    var today = todayKey();
    var start = parseDate(today);
    start.setDate(start.getDate() - start.getDay());
    var weekDays = Array.from({ length: 7 }, function (_, index) { var date = new Date(start); date.setDate(date.getDate() + index); return localDate(date); });
    return (integrated ? '<div class="stack"><section class="card"><div class="card-title-row"><div><h2>Habit check-ins</h2><p class="small-note">Manage routines and recorded weekly progress.</p></div><button class="button primary" data-action="add-habit">＋ Add habit</button></div>' : pageHeading('Habits', 'Small routines add up. Keep building at your own pace.', '<button class="button primary" data-action="add-habit">＋ Add habit</button>')) +
      '<div class="notice info" style="margin-bottom:16px">Every new day is another chance to build a good habit.</div>' +
      '<section class="card"><div class="card-title-row"><h2>Today’s habits</h2><span class="muted">' + habits.filter(function (habit) { return habitDone(habit.id, today); }).length + ' of ' + habits.length + ' complete</span></div>' +
      (habits.length ? habits.map(function (habit) {
        var logs = state.habitLogs.filter(function (log) { return log.habitId === habit.id; });
        var streak = habitStreak(habit);
        return '<div class="simple-row"><label class="habit-check"><input type="checkbox" data-action="toggle-habit" data-id="' + escapeHtml(habit.id) + '" data-date="' + today + '"' + (habitDone(habit.id, today) ? ' checked' : '') + '><span class="row-info"><strong>' + escapeHtml(habit.name) + '</strong><small>' + escapeHtml(habit.description || habit.frequency + (habit.frequency === 'Weekly' ? ' · target ' + (habit.weeklyTarget || 3) + ' days/week' : '')) + '</small></span></label><span class="streak">↗ ' + streak + ' ' + (habit.frequency === 'Weekly' ? 'weeks' : 'day streak') + '</span><div class="table-actions"><button class="icon-button" data-action="edit-habit" data-id="' + escapeHtml(habit.id) + '" aria-label="Edit habit">✎</button><button class="icon-button" data-action="archive-habit" data-id="' + escapeHtml(habit.id) + '" aria-label="Archive habit">⌑</button></div></div>';
      }).join('') : emptyState('No habits yet.', 'Start small. Add a habit you want to build.', 'add-habit', 'Add a habit')) + '</section>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>This week</h2><span class="muted">Saved completion history</span></div>' +
      (habits.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Habit</th>' + weekDays.map(function (day) { return '<th style="text-align:center">' + escapeHtml(parseDate(day).toLocaleDateString(undefined, { weekday: 'short' })) + '<br>' + escapeHtml(parseDate(day).getDate()) + '</th>'; }).join('') + '<th>Progress</th></tr></thead><tbody>' + habits.map(function (habit) { var count = weekDays.filter(function (day) { return habitDone(habit.id, day); }).length; return '<tr><td>' + escapeHtml(habit.name) + '</td>' + weekDays.map(function (day) { return '<td style="text-align:center"><input type="checkbox" data-action="toggle-habit" data-id="' + escapeHtml(habit.id) + '" data-date="' + day + '" aria-label="' + escapeHtml(habit.name + ' on ' + day) + '"' + (habitDone(habit.id, day) ? ' checked' : '') + '></td>'; }).join('') + '<td>' + count + ' / 7</td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('Habit history will appear here.', 'Add a habit, then check it off on the days you complete it.')) + '</section>' + (integrated ? '</div>' : '');
  }

  function habitStreak(habit) {
    var count = 0;
    var date = parseDate(todayKey());
    if (habit.frequency === 'Weekly') {
      date.setDate(date.getDate() - date.getDay());
      for (var week = 0; week < 104; week += 1) {
        var weekStart = new Date(date); weekStart.setDate(weekStart.getDate() - week * 7);
        var weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
        var startKey = localDate(weekStart); var endKey = localDate(weekEnd);
        var daysCount = state.habitLogs.filter(function (log) { return log.habitId === habit.id && log.date >= startKey && log.date <= endKey; }).length;
        if (daysCount >= Number(habit.weeklyTarget || 3)) count += 1; else break;
      }
      return count;
    }
    if (!habitDone(habit.id, todayKey())) date.setDate(date.getDate() - 1);
    for (var i = 0; i < 1000; i += 1) {
      if (!habitDone(habit.id, localDate(date))) break;
      count += 1;
      date.setDate(date.getDate() - 1);
    }
    return count;
  }

  function renderProgress() {
    var start = parseDate(todayKey());
    var end = new Date(start);
    if (progressRange === 'week') {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    } else if (progressRange === 'month') {
      start.setDate(1);
    } else {
      start = parseDate(customRange.start) || new Date();
      end = parseDate(customRange.end) || new Date();
    }
    start.setHours(0, 0, 0, 0); end.setHours(23, 59, 59, 999);
    var from = localDate(start); var to = localDate(end);
    var tasksDone = state.tasks.filter(function (task) { return task.completedAt && task.completedAt.slice(0, 10) >= from && task.completedAt.slice(0, 10) <= to; });
    var remaining = state.tasks.filter(function (task) { return task.status !== 'Completed' && task.dueDate && task.dueDate >= from && task.dueDate <= to; }).length;
    var overdue = state.tasks.filter(function (task) { return statusForTask(task) === 'Overdue'; }).length;
    var study = completedStudyMinutes(from, to);
    var activeHabits = state.habits.filter(function (habit) { return habit.active !== 'Archived'; });
    var habitTotal = activeHabits.length;
    var habitEnd = localDate(end) > todayKey() ? parseDate(todayKey()) : end;
    var logs = state.habitLogs.filter(function (log) {
      return log.date >= from && log.date <= localDate(habitEnd) && activeHabits.some(function (habit) { return habit.id === log.habitId; });
    }).length;
    var habitPossible = activeHabits.reduce(function (sum, habit) {
      var first = habit.startDate && habit.startDate > from ? parseDate(habit.startDate) : new Date(start);
      var last = habitEnd;
      if (first > last) return sum;
      var eligibleDays = Math.floor((Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) - Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) / 86400000) + 1;
      if (habit.frequency === 'Weekly') {
        var weekCount = Math.ceil((eligibleDays + first.getDay()) / 7);
        return sum + Math.min(eligibleDays, weekCount * Number(habit.weeklyTarget || 3));
      }
      return sum + eligibleDays;
    }, 0);
    var habitRate = habitPossible ? Math.min(100, Math.round(logs / habitPossible * 100)) : 0;
    var maxTasks = Math.max(1, tasksDone.length, remaining, overdue);
    var subjectSummary = state.subjects.map(function (subject) {
      var items = state.assessments.filter(function (assessment) { return assessment.subjectId === subject.id && assessment.date >= from && assessment.date <= to; });
      if (!items.length) return '';
      var avg = items.reduce(function (sum, item) { return sum + item.score / item.maximum * 100; }, 0) / items.length;
      return '<div class="bar-item"><span>' + escapeHtml(subject.name) + '</span><span class="progress-track"><span class="progress-fill" style="display:block;width:' + avg + '%"></span></span><span>' + avg.toFixed(0) + '%</span></div>';
    }).filter(Boolean).join('');
    var currentProgressSignature = JSON.stringify({
      from: from, to: to, completed: tasksDone.map(function (task) { return [task.id, task.completedAt]; }),
      remaining: remaining, overdue: overdue, study: study, logs: logs, habitPossible: habitPossible,
      assessments: subjectSummary
    });
    progressAnimationPending = currentProgressSignature !== progressSignature;
    progressSignature = currentProgressSignature;
    return pageHeading('Progress', 'A clear view of activity you have actually recorded.', '<div class="segmented"><button data-action="progress-range" data-value="week" class="' + (progressRange === 'week' ? 'selected' : '') + '">This week</button><button data-action="progress-range" data-value="month" class="' + (progressRange === 'month' ? 'selected' : '') + '">This month</button><button data-action="progress-range" data-value="custom" class="' + (progressRange === 'custom' ? 'selected' : '') + '">Custom</button></div>') +
      (progressRange === 'custom' ? '<div class="toolbar"><label>From <input type="date" name="range-start" value="' + escapeHtml(customRange.start) + '"></label><label>To <input type="date" name="range-end" value="' + escapeHtml(customRange.end) + '"></label><button class="button" data-action="apply-range">Apply</button></div>' : '') +
      '<section class="summary-grid">' + summaryCard('Tasks completed', String(tasksDone.length), 'Completed in selected range', '✓') + summaryCard('Tasks remaining', String(remaining), 'Due in selected range', '☷') + summaryCard('Overdue tasks', String(overdue), 'Currently incomplete', '◷') + summaryCard('Study time', formatMinutes(study), 'Recorded completed study time', '◎') + '</section>' +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Task activity</h2><span class="muted">Completed once per task</span></div><div class="bar-list">' +
      progressBar('Completed', tasksDone.length, maxTasks) + progressBar('Remaining', remaining, maxTasks) + progressBar('Overdue', overdue, maxTasks) +
      '</div></section><section class="card"><div class="card-title-row"><h2>Habits</h2><span class="muted">Recorded check-ins</span></div><div class="inline-stat"><strong>' + habitRate + '%</strong><span class="muted">completion rate</span></div><div class="progress-track" style="width:100%;margin:14px 0"><span class="progress-fill" style="display:block;width:' + habitRate + '%"></span></div><p class="small-note">' + logs + ' check-ins recorded across ' + habitTotal + ' active habits.</p></section></div>' +
      '<section class="section-grid" style="margin-top:16px"><article class="card"><div class="card-title-row"><h2>Focus sessions</h2></div><div class="inline-stat"><strong>' + state.timer.completedSessions.filter(function (session) { return session.phase === 'focus' && dateInConfiguredTimezone(new Date(session.completedAt)) >= from && dateInConfiguredTimezone(new Date(session.completedAt)) <= to; }).length + '</strong><span class="muted">completed in period</span></div><p class="small-note">Only completed focus sessions count. Planned study time is reported separately from those sessions.</p></article><article class="card"><div class="card-title-row"><h2>Academic assessments</h2></div>' + (subjectSummary ? '<div class="bar-list">' + subjectSummary + '</div><p class="small-note">Percentages use recorded scores; they are not official grades.</p>' : emptyState('No assessment data for this period.', 'Record assessment scores in Academics.')) + '</article></section>' + renderHabits(true);
  }

  function progressBar(label, value, max) {
    return '<div class="bar-item"><span>' + escapeHtml(label) + '</span><span class="progress-track"><span class="progress-fill" style="display:block;width:' + (value / max * 100) + '%"></span></span><strong>' + value + '</strong></div>';
  }

  function renderSettings() {
    var p = state.preferences;
    var reminders = state.notifications.filter(function (notification) { return notification.status === 'scheduled' && !notification.dismissedAt; }).sort(function (a, b) { return a.remindAt - b.remindAt; });
    var permission = 'unsupported';
    if ('Notification' in window) permission = Notification.permission;
    return pageHeading('Settings', 'Personalize your organizer and manage local data.', '') +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Profile &amp; preferences</h2></div>' +
      '<p class="small-note">Changes save automatically in this browser.</p>' +
      '<form data-form="settings" class="form-grid">' +
      settingsInput('Your name', 'name', p.name, 'text', 'Shown in your greeting') +
      settingsSelect('Theme', 'theme', p.theme, [['system', 'System default'], ['light', 'Light'], ['dark', 'Dark']]) +
      settingsInput('Timezone', 'timezone', p.timezone, 'text', 'Example: Asia/Manila') +
      settingsSelect('Date format', 'dateFormat', p.dateFormat, [['medium', 'MMM D, YYYY'], ['short', 'MM/DD/YYYY'], ['iso', 'YYYY-MM-DD']]) +
      settingsSelect('Time format', 'timeFormat', p.timeFormat, [['12h', '12-hour'], ['24h', '24-hour']]) +
      settingsInput('Focus duration (minutes)', 'focusMinutes', p.focusMinutes, 'number', '', 1) +
      settingsInput('Short break (minutes)', 'shortBreakMinutes', p.shortBreakMinutes, 'number', '', 1) +
      settingsInput('Long break (minutes)', 'longBreakMinutes', p.longBreakMinutes, 'number', '', 1) +
      '</form></section>' +
      '<div class="stack"><section class="card"><div class="card-title-row"><h2>Reminders &amp; notifications</h2><span class="status-pill">' + escapeHtml(permission) + '</span></div><p class="small-note">In-app reminders are checked while My PeOr is open. Browser notifications are optional and require your permission. There is no background notification service configured.</p>' +
      '<button class="button" data-action="notifications"' + (permission === 'denied' || permission === 'unsupported' ? ' disabled' : '') + '>' + (permission === 'denied' ? 'Blocked in browser settings' : permission === 'unsupported' ? 'Browser notifications unavailable' : p.notifications ? 'Disable browser notifications' : 'Enable browser notifications') + '</button>' +
      (permission === 'denied' ? '<p class="small-note">To try browser alerts again, allow notifications for this site in your browser settings. In-app reminders remain available while My PeOr is open.</p>' : '') +
      (reminders.length ? '<div class="task-list" style="margin-top:12px">' + reminders.map(function (item) { return '<div class="simple-row"><span class="row-info"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(dateTimeLabel(new Date(item.remindAt).toISOString())) + '</small></span></div>'; }).join('') + '</div>' : '<p class="small-note">No upcoming reminders configured.</p>') + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>Data &amp; privacy</h2></div><div class="notice info"><strong>No account required.</strong> Organizer data is saved in this browser profile and is not sent to a server. It is not synchronized across devices and is not an account-based secure backup.</div>' +
      '<div class="setting-row"><div><strong>Export backup</strong><small>Download all locally stored organizer data as a JSON backup.</small></div><button class="button" data-action="export">Export Backup</button></div>' +
      '<div class="setting-row"><div><strong>Import backup</strong><small>Validate a JSON backup, then replace the data in this browser.</small></div><button class="button" data-action="import-backup">Import Backup</button></div>' +
      '<div class="setting-row"><div><strong>Clear all data</strong><small>Permanently deletes all My PeOr items and preferences stored in this browser.</small></div><button class="button danger" data-action="clear-data">Clear All Data</button></div></section></div></div>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Local data &amp; privacy</h2></div><div class="notice info"><strong>No account required.</strong> My PeOr saves your organizer data in IndexedDB in this browser profile. Data is not sent to a server, is not synchronized across devices, and may be cleared if browser site data is removed.</div></section>';
  }

  function renderAbout() {
    return pageHeading('About My PeOr', 'A simple space to plan your day and make progress toward your goals.', '') +
      '<section class="card about-creator-card"><p class="eyebrow">About the Creator</p><h2>Samuel Bumatay</h2>' +
      '<p>Hi! I\'m Samuel Bumatay, the creator of My PeOr. I created this website to help students and people who want to become more organized, manage their time wisely, and stay on track with their goals.</p>' +
      '<p>My goal is to make everyday planning easier by providing a simple and accessible space where people can organize their tasks, track their deadlines, plan their schedules, and improve their productivity.</p>' +
      '<p>I believe that small steps, when done consistently, can lead to meaningful progress. Through My PeOr, I hope to help people become more organized, productive, and motivated to achieve their goals.</p>' +
      '<a class="button primary about-facebook" href="https://www.facebook.com/samuel.bumatay.2024" target="_blank" rel="noopener noreferrer">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13.4 21v-8h2.7l.4-3.1h-3.1v-2c0-.9.3-1.5 1.6-1.5h1.7V3.6c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.1H7.2V13H10v8h3.4Z"/></svg>' +
      '<span>Visit My Facebook Profile</span><span aria-hidden="true">↗</span></a></section>';
  }

  function settingsInput(label, name, value, type, hint, min) {
    return '<div class="form-field"><label for="setting-' + name + '">' + label + '</label><input id="setting-' + name + '" name="' + name + '" type="' + type + '" value="' + escapeHtml(value) + '"' + (min ? ' min="' + min + '"' : '') + '>' + (hint ? '<small class="form-hint">' + hint + '</small>' : '') + '</div>';
  }

  function settingsSelect(label, name, value, choices) {
    return '<div class="form-field"><label for="setting-' + name + '">' + label + '</label><select id="setting-' + name + '" name="' + name + '">' + choices.map(function (choice) { return '<option value="' + choice[0] + '"' + (value === choice[0] ? ' selected' : '') + '>' + choice[1] + '</option>'; }).join('') + '</select></div>';
  }

  function savePreferences(form, reportErrors) {
    var data = Object.fromEntries(new FormData(form).entries());
    if (!data.timezone.trim()) {
      if (reportErrors) formError(form, 'Timezone is required (for example, Asia/Manila).');
      return false;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format(new Date());
    } catch (error) {
      if (reportErrors) formError(form, 'Enter a valid timezone, such as Asia/Manila.');
      return false;
    }
    var durations = ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes'];
    for (var i = 0; i < durations.length; i += 1) {
      var key = durations[i];
      if (!Number.isInteger(Number(data[key])) || Number(data[key]) < 1 || Number(data[key]) > 180) {
        if (reportErrors) formError(form, 'Pomodoro durations must be whole numbers between 1 and 180 minutes.');
        return false;
      }
      data[key] = Number(data[key]);
    }
    var durationChanged = durations.some(function (key) { return Number(state.preferences[key]) !== data[key]; });
    state.preferences = Object.assign(state.preferences, data);
    if (durationChanged && state.timer.status !== 'running') state.timer.remainingMs = getPhaseMinutes() * 60000;
    saveState();
    applyTheme();
    document.querySelector('#sidebar-name').textContent = state.preferences.name || 'My Organizer';
    document.querySelector('#sidebar-avatar').textContent = (state.preferences.name || 'M').trim().charAt(0).toUpperCase();
    return true;
  }

  function applyTheme() {
    var theme = state.preferences.theme;
    if (theme === 'system') theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelector('.theme-toggle').textContent = theme === 'dark' ? '☀' : '☾';
  }

  var pages = {
    dashboard: ['Dashboard', renderDashboard],
    tasks: ['My Tasks', renderTasks],
    search: ['Search', renderSearch],
    schedule: ['My Schedule', renderSchedule],
    academics: ['Academics', renderAcademics],
    lessons: ['Lesson Organizer', renderLessonOrganizer],
    deadlines: ['Deadlines', renderDeadlines],
    notifications: ['Notifications', renderNotifications],
    progress: ['Progress', renderProgress],
    settings: ['Settings', renderSettings],
    about: ['About My PeOr', renderAbout]
  };

  function render() {
    if (!pages[currentPage]) currentPage = 'dashboard';
    if (syncReminderQueue()) saveState();
    setStorageStatus(storageStatus, storageErrorMessage);
    document.querySelector('#current-section').textContent = pages[currentPage][0];
    document.querySelectorAll('.nav-item[data-page]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.page === currentPage);
      if (button.dataset.page === currentPage) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelector('#sidebar-name').textContent = state.preferences.name || 'My Organizer';
    document.querySelector('#sidebar-avatar').textContent = (state.preferences.name || 'M').trim().charAt(0).toUpperCase();
    document.querySelector('#sidebar').classList.toggle('collapsed', Boolean(state.preferences.sidebarCollapsed));
    document.querySelector('.main-column').classList.toggle('sidebar-collapsed', Boolean(state.preferences.sidebarCollapsed));
    updateNotificationBadges();
    document.querySelector('#global-search').value = globalSearch;
    document.querySelector('.search-clear').hidden = !globalSearch;
    document.querySelectorAll('.mobile-bottom-nav [data-page]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.page === currentPage);
    });
    applyTheme();
    main.dataset.page = currentPage;
    main.innerHTML = pages[currentPage][1]();
    var showDashboardIntro = currentPage === 'dashboard' && !dashboardIntroPlayed;
    main.classList.toggle('dashboard-first', showDashboardIntro);
    if (showDashboardIntro) dashboardIntroPlayed = true;
    main.classList.toggle('lesson-entry', currentPage === 'lessons' && lessonIntroPending);
    if (currentPage === 'lessons' && lessonIntroPending) {
      lessonIntroPending = false;
      window.setTimeout(function () { main.classList.remove('lesson-entry'); }, 500);
    }
    main.classList.toggle('progress-updated', currentPage === 'progress' && progressAnimationPending);
    progressAnimationPending = false;
    timerPhaseChanged = false;
    taskCompletionPulseId = '';
    taskCompletionCelebration = false;
  }

  function updateNotificationBadges() {
    var unreadCount = state.notifications.filter(function (item) { return item.status === 'unread' && !item.dismissedAt; }).length;
    var notificationDot = document.querySelector('#notification-dot');
    notificationDot.hidden = unreadCount === 0;
    notificationDot.setAttribute('aria-label', unreadCount + ' unread notifications');
    var navCount = document.querySelector('#sidebar-notification-count');
    navCount.hidden = unreadCount === 0;
    navCount.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
  }

  function setPage(page) {
    if (page === 'calendar') { scheduleTab = 'calendar'; page = 'schedule'; }
    else if (page === 'schedule-timeline') { scheduleTab = 'calendar'; page = 'schedule'; }
    else if (page === 'planner') { scheduleTab = 'exams'; page = 'schedule'; }
    else if (page === 'subjects') { academicsTab = 'subjects'; page = 'academics'; }
    else if (page === 'habits') page = 'progress';
    if (!pages[page]) return;
    if (page === 'lessons') lessonIntroPending = true;
    currentPage = page;
    render();
    document.querySelector('#sidebar').classList.remove('mobile-open');
    main.focus({ preventScroll: true });
  }

  function validateForm(form) {
    var valid = true;
    form.querySelectorAll('.field-error').forEach(function (node) { node.textContent = ''; node.classList.remove('visible'); });
    form.querySelectorAll('[required]').forEach(function (input) {
      if (!input.value.trim()) {
        valid = false;
        var error = input.parentElement.querySelector('.field-error');
        if (error) { error.textContent = 'This field is required.'; error.classList.add('visible'); }
      }
    });
    form.querySelectorAll('input[type="number"]').forEach(function (input) {
      if (!input.value) return;
      var number = Number(input.value);
      var minimum = input.min === '' ? -Infinity : Number(input.min);
      var maximum = input.max === '' ? Infinity : Number(input.max);
      if (!isFinite(number) || number < minimum || number > maximum) {
        valid = false;
        var error = input.parentElement.querySelector('.field-error');
        if (error) {
          error.textContent = !isFinite(number) ? 'Enter a valid number.' : number < minimum ? 'Must be at least ' + minimum + '.' : 'Must be no more than ' + maximum + '.';
          error.classList.add('visible');
        }
      }
    });
    if (!valid) {
      var firstInvalid = form.querySelector(':invalid');
      if (firstInvalid) firstInvalid.focus();
    }
    return valid;
  }

  function saveForm(form) {
    var type = form.dataset.form;
    var id = form.dataset.id;
    var formData = new FormData(form);
    var data = Object.fromEntries(formData.entries());
    if (form.querySelector('[name="days"]')) data.days = formData.getAll('days');
    if (form.querySelector('[name="reminderOffsets"]')) data.reminderOffsets = formData.getAll('reminderOffsets');
    if (!validateForm(form)) return;
    var record;
    var classOverlap = false;
    if (type === 'task') {
      if (data.estimatedMinutes && Number(data.estimatedMinutes) < 1) return fieldProblem(form, 'estimatedMinutes', 'Duration must be at least 1 minute.');
      record = Object.assign({}, data, {
        id: id || makeId(),
        priority: data.priority || 'Medium',
        status: data.status || 'To Do',
        category: data.category || 'Personal',
        createdAt: id ? getRecord('tasks', id).createdAt : new Date().toISOString(),
        completedAt: data.status === 'Completed' ? (id && getRecord('tasks', id).completedAt || new Date().toISOString()) : ''
      });
      if (data.status !== 'Completed') record.completedAt = '';
      var oldTask = id && getRecord('tasks', id);
      if (oldTask && oldTask.status === 'Completed' && data.status !== 'Completed') record.completedAt = '';
      if (oldTask && oldTask.reminderAt !== data.reminderAt) {
        state.dismissedReminders = state.dismissedReminders.filter(function (dismissedId) { return dismissedId !== id; });
      }
      upsert('tasks', record);
    } else if (type === 'schedule') {
      if (data.endTime <= data.startTime) return formError(form, 'End time must be later than start time.');
      record = Object.assign({}, data, { id: id || makeId() });
      upsert('schedule', record);
    } else if (type === 'classSchedule') {
      if (!data.days.length) return formError(form, 'Choose at least one day for this recurring class.');
      if (data.endTime <= data.startTime) return formError(form, 'End time must be later than start time.');
      var linkedSubject = data.subjectId ? getRecord('subjects', data.subjectId) : null;
      if (linkedSubject) {
        data.subjectName = data.subjectName || linkedSubject.name;
        data.subjectCode = data.subjectCode || linkedSubject.code || '';
      }
      record = Object.assign({}, data, { id: id || makeId() });
      upsert('classSchedules', record);
      classOverlap = state.classSchedules.some(function (other) {
        return other.id !== record.id && record.days.some(function (day) {
          return classForDay(other, day) && record.startTime < other.endTime && other.startTime < record.endTime;
        });
      });
    } else if (type === 'flashcard') {
      record = Object.assign({}, data, { id: id || makeId() });
      upsert('flashcards', record);
    } else if (type === 'subject') {
      record = Object.assign({}, data, { id: id || makeId(), icon: String(data.icon || '').trim().slice(0, 6), color: /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#5368d8' });
      upsert('subjects', record);
    } else if (type === 'lesson') {
      var lessonSubject = getRecord('subjects', form.dataset.subjectId || lessonSubjectId);
      if (!lessonSubject) return formError(form, 'Choose an existing subject before adding a lesson.');
      if (data.lessonNumber && (!Number.isInteger(Number(data.lessonNumber)) || Number(data.lessonNumber) < 1)) return fieldProblem(form, 'lessonNumber', 'Lesson number must be a positive whole number.');
      var existingLesson = id ? getRecord('lessons', id) : null;
      var nextOrder = state.lessons.filter(function (item) { return item.subjectId === lessonSubject.id; }).reduce(function (highest, item) { return Math.max(highest, Number(item.order) || 0); }, 0) + 1;
      record = Object.assign({}, data, {
        id: id || makeId(),
        subjectId: lessonSubject.id,
        lessonNumber: data.lessonNumber ? Number(data.lessonNumber) : '',
        order: existingLesson ? Number(existingLesson.order) || nextOrder : nextOrder,
        reviewStatus: data.reviewStatus === 'Reviewed' ? 'Reviewed' : 'Not Reviewed',
        createdAt: existingLesson ? existingLesson.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      upsert('lessons', record);
    } else if (type === 'assessment') {
      var score = Number(data.score); var maximum = Number(data.maximum);
      if (!isFinite(score) || !isFinite(maximum) || maximum <= 0 || score < 0 || score > maximum) return formError(form, 'Enter a nonnegative score no greater than a positive maximum score.');
      if (data.weight && (Number(data.weight) < 0 || Number(data.weight) > 100)) return fieldProblem(form, 'weight', 'Weight must be between 0 and 100%.');
      record = Object.assign({}, data, { id: id || makeId(), score: score, maximum: maximum, weight: data.weight ? Number(data.weight) : '' });
      upsert('assessments', record);
    } else if (type === 'exam') {
      record = Object.assign({}, data, { id: id || makeId(), priority: data.priority || 'Medium' });
      upsert('exams', record);
    } else if (type === 'study') {
      record = Object.assign({}, data, { id: id || makeId(), plannedMinutes: Number(data.plannedMinutes || 0), actualMinutes: Number(data.actualMinutes || 0), status: data.status || 'Planned' });
      upsert('studySessions', record);
    } else if (type === 'habit') {
      record = Object.assign({}, data, { id: id || makeId(), weeklyTarget: Number(data.weeklyTarget || 3), active: data.active || 'Active' });
      upsert('habits', record);
    }
    saveState();
    closeModal();
    render();
    if (classOverlap) toast('Class schedule saved, but it overlaps another class on at least one selected day.', true);
    else toast(id ? 'Changes saved.' : 'Added successfully.');
  }

  function fieldProblem(form, name, message) {
    var input = form.elements[name];
    var error = input && input.parentElement.querySelector('.field-error');
    if (error) { error.textContent = message; error.classList.add('visible'); input.focus(); }
  }

  function formError(form, message) {
    var error = form.querySelector('.form-error');
    if (!error) {
      error = document.createElement('p');
      error.className = 'form-error danger-text';
      form.prepend(error);
    }
    error.textContent = message;
  }

  function getRecord(collection, id) {
    return state[collection].find(function (item) { return item.id === id; });
  }

  function upsert(collection, record) {
    var index = state[collection].findIndex(function (item) { return item.id === record.id; });
    if (index < 0) state[collection].push(record);
    else state[collection][index] = record;
  }

  function deleteRecord(collection, id, label, onDone) {
    var confirmation = collection === 'subjects'
      ? 'Permanently delete this subject, its grade records, lessons, and all lesson files? Other tasks and schedules linked to this subject will be unlinked. This cannot be undone.'
      : 'Delete this ' + label + '? This cannot be undone.';
    if (!window.confirm(confirmation)) return;
    state[collection] = state[collection].filter(function (item) { return item.id !== id; });
    if (collection === 'habits') state.habitLogs = state.habitLogs.filter(function (log) { return log.habitId !== id; });
    if (collection === 'flashcards') revealedFlashcards.delete(id);
    if (collection === 'lessons') state.lessonAttachments = state.lessonAttachments.filter(function (file) { return file.lessonId !== id; });
    if (collection === 'subjects') {
      if (lessonSubjectId === id) lessonSubjectId = '';
      state.assessments = state.assessments.filter(function (item) { return item.subjectId !== id; });
      var subjectLessonIds = state.lessons.filter(function (item) { return item.subjectId === id; }).map(function (item) { return item.id; });
      state.lessons = state.lessons.filter(function (item) { return item.subjectId !== id; });
      state.lessonAttachments = state.lessonAttachments.filter(function (file) { return file.subjectId !== id && subjectLessonIds.indexOf(file.lessonId) < 0; });
      state.tasks.forEach(function (task) { if (task.subjectId === id) task.subjectId = ''; });
      state.schedule.forEach(function (item) { if (item.subjectId === id) item.subjectId = ''; });
      state.classSchedules.forEach(function (item) { if (item.subjectId === id) item.subjectId = ''; });
    }
    saveState();
    if (onDone) onDone();
    render();
    toast(label.charAt(0).toUpperCase() + label.slice(1) + ' deleted.');
  }

  function toggleTask(id, checked) {
    var task = getRecord('tasks', id);
    if (!task) return;
    task.status = checked ? 'Completed' : 'To Do';
    task.completedAt = checked ? new Date().toISOString() : '';
    if (checked) {
      taskCompletionPulseId = id;
      var todayTasks = dayTasks(todayKey());
      taskCompletionCelebration = todayTasks.length > 0 && todayTasks.every(function (item) { return item.status === 'Completed'; });
    } else {
      taskCompletionPulseId = '';
      taskCompletionCelebration = false;
    }
    var allTasksDone = taskCompletionCelebration;
    saveState();
    render();
    if (checked) {
      toast('Nice work!');
      if (allTasksDone) toast('You completed all of today’s tasks!', false, true);
    }
  }
  function toggleHabit(id, date, checked) {
    var index = state.habitLogs.findIndex(function (log) { return log.habitId === id && log.date === date; });
    if (checked && index === -1) state.habitLogs.push({ habitId: id, date: date, completedAt: new Date().toISOString() });
    if (!checked && index !== -1) state.habitLogs.splice(index, 1);
    saveState();
    render();
  }

  function selectedDateChange(days) {
    var date = parseDate(selectedDate) || new Date();
    date.setDate(date.getDate() + days);
    selectedDate = localDate(date);
    calendarDate = new Date(date.getFullYear(), date.getMonth(), 1);
    render();
  }

  function startTimer() {
    var timer = state.timer;
    if (timer.status === 'running') return;
    if (!timer.remainingMs || timer.remainingMs <= 0) timer.remainingMs = getPhaseMinutes() * 60000;
    timer.endAt = Date.now() + timer.remainingMs;
    timer.status = 'running';
    timer.recoveredExpired = false;
    saveState();
    runTimer();
  }

  function getPhaseMinutes() {
    return state.timer.phase === 'focus' ? state.preferences.focusMinutes :
      state.timer.phase === 'shortBreak' ? state.preferences.shortBreakMinutes : state.preferences.longBreakMinutes;
  }

  function pauseTimer() {
    if (state.timer.status !== 'running') return;
    state.timer.remainingMs = Math.max(0, state.timer.endAt - Date.now());
    state.timer.endAt = null;
    state.timer.status = 'paused';
    saveState();
    render();
  }

  function resetTimer() {
    state.timer.status = 'idle';
    state.timer.endAt = null;
    state.timer.remainingMs = getPhaseMinutes() * 60000;
    state.timer.recoveredExpired = false;
    saveState();
    render();
  }

  function skipTimer() {
    if (state.timer.phase === 'focus') {
      state.timer.phase = state.timer.focusCount > 0 && state.timer.focusCount % 4 === 0 ? 'longBreak' : 'shortBreak';
    } else {
      state.timer.phase = 'focus';
    }
    state.timer.status = 'idle';
    state.timer.endAt = null;
    state.timer.remainingMs = getPhaseMinutes() * 60000;
    state.timer.recoveredExpired = false;
    timerPhaseChanged = true;
    saveState();
    render();
  }

  function completeTimer() {
    var timer = state.timer;
    if (timer.phase === 'focus') {
      var minutes = Number(state.preferences.focusMinutes);
      timer.completedSessions.push({ id: makeId(), phase: 'focus', minutes: minutes, completedAt: new Date().toISOString() });
      timer.focusCount += 1;
      timer.phase = timer.focusCount % 4 === 0 ? 'longBreak' : 'shortBreak';
      toast('Focus session complete. Take a break.');
    } else {
      timer.phase = 'focus';
      toast('Break complete. Ready for another focus session?');
    }
    timer.status = 'idle';
    timer.endAt = null;
    timer.remainingMs = getPhaseMinutes() * 60000;
    timerPhaseChanged = true;
    saveState();
    render();
    if (state.preferences.notifications && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('My PeOr timer', { body: timer.phase === 'focus' ? 'Break finished.' : 'Focus session finished.' });
    }
  }

  function runTimer() {
    if (timerInterval) window.clearInterval(timerInterval);
    timerInterval = window.setInterval(function () {
      if (state.timer.status !== 'running') return;
      var remaining = state.timer.endAt - Date.now();
      if (remaining <= 0) {
        window.clearInterval(timerInterval);
        completeTimer();
        return;
      }
      var timeNode = document.querySelector('.timer-time');
      if (timeNode) timeNode.textContent = Math.floor(remaining / 60000).toString().padStart(2, '0') + ':' + Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
      var ring = document.querySelector('.timer-ring');
      if (ring) ring.style.setProperty('--timer-progress', ((1 - remaining / (getPhaseMinutes() * 60000)) * 100) + '%');
    }, 250);
  }

  function addCalendarItem() {
    openModal('Add to ' + dateLabel(selectedDate), '<div class="stack"><button class="button w-100" data-action="add-task-selected">Add a task</button><button class="button w-100" data-action="add-schedule-selected">Add a schedule block</button><button class="button w-100" data-action="add-exam-selected">Add an exam</button><button class="button w-100" data-action="add-study-selected">Plan a study session</button></div>');
  }

  function markStudyComplete(id) {
    var session = getRecord('studySessions', id);
    if (!session) return;
    session.status = session.status === 'Completed' ? 'Planned' : 'Completed';
    if (session.status === 'Completed' && !session.actualMinutes) session.actualMinutes = Number(session.plannedMinutes || 0);
    saveState(); render();
  }

  function hasUserData(value) {
    var defaults = freshState();
    return ['tasks', 'schedule', 'classSchedules', 'subjects', 'assessments', 'exams', 'studySessions', 'flashcards', 'lessons', 'lessonAttachments', 'habits', 'habitLogs', 'notifications']
      .some(function (key) { return value[key] && value[key].length; }) ||
      (value.dismissedReminders && value.dismissedReminders.length) ||
      value.timetablePreferences.startHour !== defaults.timetablePreferences.startHour ||
      value.timetablePreferences.endHour !== defaults.timetablePreferences.endHour ||
      Object.keys(defaults.preferences).some(function (key) { return value.preferences[key] !== defaults.preferences[key]; }) ||
      Object.keys(defaults.timer).some(function (key) {
        if (key === 'completedSessions') return value.timer.completedSessions && value.timer.completedSessions.length;
        return JSON.stringify(value.timer[key]) !== JSON.stringify(defaults.timer[key]);
      }) || value.quoteIndex !== 0 || value.demoMode;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('An attachment could not be added to the backup.')); };
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(value) {
    var match = /^data:([^;,]+)?;base64,([a-z0-9+/=]+)$/i.exec(value);
    if (!match) throw new Error('Backup contains an invalid lesson attachment.');
    var binary = atob(match[2]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1] || 'application/octet-stream' });
  }

  async function exportData() {
    try {
      var backupState = cloneState(state);
      backupState.lessonAttachments = await Promise.all(state.lessonAttachments.map(async function (file) {
        var exportedFile = Object.assign({}, file);
        if (!(file.data instanceof Blob)) throw new Error('An attachment is unavailable and could not be included in the backup.');
        exportedFile.dataUrl = await blobToDataUrl(file.data);
        delete exportedFile.data;
        return exportedFile;
      }));
      var backup = {
        app: 'My PeOr',
        schemaVersion: DATABASE_VERSION,
        exportedAt: new Date().toISOString(),
        data: backupState
      };
      var blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'my-peor-backup-' + todayKey() + '.json';
      link.click();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('My PeOr backup downloaded, including lesson attachments.');
    } catch (error) {
      console.error('Unable to export My PeOr backup.', error);
      toast(error && error.message ? error.message : 'The backup could not be exported.', true);
    }
  }

  async function importBackup(file) {
    try {
      var parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Backup must contain a JSON object.');
      if (parsed.schemaVersion && parsed.schemaVersion > DATABASE_VERSION) throw new Error('This backup was created by a newer My PeOr version. Update the website before importing it.');
      var knownKeys = ['tasks', 'schedule', 'classSchedules', 'subjects', 'assessments', 'exams', 'studySessions', 'flashcards', 'lessons', 'lessonAttachments', 'habits', 'habitLogs', 'preferences', 'timer', 'notifications', 'timetablePreferences'];
      var source = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      if (!source || !knownKeys.some(function (key) { return Object.prototype.hasOwnProperty.call(source, key); })) {
        throw new Error('This file does not contain a My PeOr backup.');
      }
      if (Array.isArray(source.lessonAttachments)) {
        source.lessonAttachments.forEach(function (file) {
          if (file && typeof file.dataUrl === 'string') {
            if (file.dataUrl.length > Math.ceil(MAX_LESSON_FILE_SIZE * 4 / 3) + 100) throw new Error('A lesson attachment in this backup exceeds the 15 MB file limit.');
            file.data = dataUrlToBlob(file.dataUrl);
            delete file.dataUrl;
          }
        });
      }
      var importedState = normalizeState(parsed, true);
      if (hasUserData(state) && !window.confirm('Importing this backup will replace all My PeOr data currently saved in this browser. Export a backup first if you want to keep it. Continue?')) return;
      await saveQueue.catch(function () {});
      try {
        var database = await openDatabase();
        await writeState(database, importedState);
      } catch (storageError) {
        setStorageStatus('error', storageError.message || 'The backup could not be saved in IndexedDB.');
        throw storageError;
      }
      state = importedState;
      saveRevision += 1;
      storageErrorMessage = '';
      setStorageStatus('saved');
      render();
      toast('My PeOr backup imported successfully.');
    } catch (error) {
      console.error('Unable to import My PeOr backup.', error);
      toast(error && error.message ? error.message : 'The backup could not be imported.', true);
    }
  }

  async function clearAllData() {
    if (!window.confirm('Permanently delete all My PeOr data saved in this browser? This cannot be undone.')) return;
    try {
      await saveQueue.catch(function () {});
      var database = await openDatabase();
      var emptyState = freshState();
      await writeState(database, emptyState);
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch (error) {
        console.warn('Legacy localStorage data could not be removed; the cleared IndexedDB state will take precedence.', error);
      }
      state = emptyState;
      saveRevision += 1;
      storageErrorMessage = '';
      setStorageStatus('saved');
      render();
      toast('All My PeOr data was cleared from this browser.');
    } catch (error) {
      setStorageStatus('error', error && error.message ? error.message : 'Browser data could not be cleared.');
      console.error('Unable to clear My PeOr IndexedDB data.', error);
      toast('Unable to clear locally stored data. ' + storageErrorMessage, true);
    }
  }

  var MAX_LESSON_FILE_SIZE = 15 * 1024 * 1024;
  var MAX_LESSON_FILES_TOTAL = 50 * 1024 * 1024;
  var LESSON_FILE_TYPES = {
    pdf: 'application/pdf',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp'
  };

  function setLessonUploadStatus(status, message, percent) {
    var statusNode = document.querySelector('#lesson-upload-status');
    var progressNode = statusNode.querySelector('progress');
    statusNode.hidden = false;
    statusNode.className = 'lesson-upload-status is-' + status;
    statusNode.querySelector('.lesson-upload-icon').textContent = status === 'saved' ? '✓' : status === 'error' ? '!' : '↥';
    statusNode.querySelector('.lesson-upload-label').textContent = message;
    if (status === 'saving') progressNode.removeAttribute('value');
    else {
      progressNode.setAttribute('value', String(Math.max(0, Math.min(100, percent || 0))));
      progressNode.setAttribute('aria-valuetext', Math.round(percent || 0) + '% read');
    }
  }

  function readLessonFile(file, progress) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      var extension = String(file.name).split('.').pop().toLowerCase();
      var mimeType = file.type || LESSON_FILE_TYPES[extension] || '';
      reader.onprogress = function (event) {
        if (event.lengthComputable) progress(event.loaded);
      };
      reader.onload = function () {
        progress(file.size);
        resolve(new Blob([reader.result], { type: mimeType }));
      };
      reader.onerror = function () { reject(reader.error || new Error('The browser could not read ' + file.name + '.')); };
      reader.onabort = function () { reject(new Error('Reading ' + file.name + ' was cancelled.')); };
      reader.readAsArrayBuffer(file);
    });
  }

  async function saveLessonFiles(files, subjectId, lessonId, replaceId) {
    var subject = getRecord('subjects', subjectId);
    if (!subject) { toast('Choose an existing subject before uploading files.', true); return; }
    var lesson = lessonId ? getRecord('lessons', lessonId) : null;
    if (lessonId && (!lesson || lesson.subjectId !== subjectId)) { toast('The selected lesson could not be found in this subject.', true); return; }
    var selected = Array.prototype.slice.call(files || []);
    if (!selected.length) return;
    if (replaceId && selected.length !== 1) { toast('Choose one file to replace the selected attachment.', true); return; }
    var oldFile = replaceId ? getRecord('lessonAttachments', replaceId) : null;
    if (replaceId && (!oldFile || oldFile.subjectId !== subjectId)) { toast('The attachment to replace could not be found.', true); return; }
    var additionalSize = selected.reduce(function (sum, file) { return sum + file.size; }, 0) - (oldFile ? Number(oldFile.size) || 0 : 0);
    var totalSize = state.lessonAttachments.reduce(function (sum, file) { return sum + (Number(file.size) || 0); }, 0);
    if (selected.some(function (file) { return !file.name || !LESSON_FILE_TYPES[String(file.name).split('.').pop().toLowerCase()]; })) {
      toast('Unsupported file type. Choose PDF, PPT/PPTX, DOC/DOCX, TXT, or a JPG/PNG/GIF/WEBP/BMP image.', true);
      return;
    }
    if (selected.some(function (file) { return !file.size; })) {
      toast('Empty files cannot be added as lesson materials.', true);
      return;
    }
    if (selected.some(function (file) { return file.size > MAX_LESSON_FILE_SIZE; })) {
      toast('Each file must be 15 MB or smaller.', true);
      return;
    }
    if (totalSize + additionalSize > MAX_LESSON_FILES_TOTAL) {
      toast('Lesson attachments are limited to 50 MB total in this organizer. Remove files or export a backup before adding more.', true);
      return;
    }
    try {
      selected.forEach(function (file) {
      var extension = String(file.name).split('.').pop().toLowerCase();
      if (file.type && file.type !== LESSON_FILE_TYPES[extension] && !(extension === 'jpg' && file.type === 'image/pjpeg')) {
        throw new Error('The selected file type does not match its file extension: ' + file.name);
      }
      });
    } catch (error) { toast(error.message, true); return; }
    if (replaceId && !window.confirm('Replace "' + oldFile.name + '" with "' + selected[0].name + '"?')) return;
    var totalUploadSize = selected.reduce(function (sum, file) { return sum + file.size; }, 0);
    var completedBytes = 0;
    var fileBlobs = [];
    setLessonUploadStatus('reading', 'Reading ' + selected.length + (selected.length === 1 ? ' file…' : ' files…'), 0);
    try {
      for (var fileIndex = 0; fileIndex < selected.length; fileIndex += 1) {
        var currentFile = selected[fileIndex];
        var currentBlob = await readLessonFile(currentFile, function (loaded) {
          var percent = (completedBytes + loaded) / totalUploadSize * 100;
          setLessonUploadStatus('reading', 'Reading ' + currentFile.name + ' · ' + Math.round(percent) + '%', percent);
        });
        fileBlobs.push(currentBlob);
        completedBytes += currentFile.size;
      }
    } catch (readError) {
      setLessonUploadStatus('error', readError.message || 'A selected file could not be read.', 0);
      throw readError;
    }
    var uploadedAt = new Date().toISOString();
    selected.forEach(function (file, index) {
      var extension = String(file.name).split('.').pop().toLowerCase();
      var record = {
        id: replaceId || makeId(),
        subjectId: subjectId,
        lessonId: lessonId || '',
        name: file.name,
        type: file.type || LESSON_FILE_TYPES[extension],
        size: file.size,
        lastModified: file.lastModified || 0,
        uploadedAt: uploadedAt,
        data: fileBlobs[index]
      };
      if (replaceId) {
        var index = state.lessonAttachments.findIndex(function (item) { return item.id === replaceId; });
        state.lessonAttachments[index] = record;
      } else state.lessonAttachments.push(record);
    });
    setLessonUploadStatus('saving', 'Saving files to this browser…', 100);
    var saved = await saveState();
    render();
    if (saved) {
      setLessonUploadStatus('saved', 'Files saved in this browser.', 100);
      window.setTimeout(function () { document.querySelector('#lesson-upload-status').hidden = true; }, 2600);
      toast(replaceId ? 'Lesson attachment replaced.' : selected.length + (selected.length === 1 ? ' file added.' : ' files added.'));
    } else {
      setLessonUploadStatus('error', storageErrorMessage || 'The files could not be saved in browser storage.', 100);
    }
  }

  function openLessonAttachment(file, download) {
    if (!file || !(file.data instanceof Blob)) { toast('This attachment is unavailable in browser storage.', true); return; }
    var url = URL.createObjectURL(file.data);
    if (download) {
      var link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function formatLessonNotes(target) {
    var textarea = modal.querySelector('[name="notes"]');
    if (!textarea) return;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var selected = textarea.value.slice(start, end);
    if (target.dataset.format === 'list') {
      var text = selected || 'List item';
      var formatted = text.split(/\r?\n/).map(function (line) { return '- ' + line; }).join('\n');
      textarea.setRangeText(formatted, start, end, 'select');
    } else {
      var marker = target.dataset.format === 'bold' ? '**' : '*';
      var formattedText = marker + (selected || 'text') + marker;
      textarea.setRangeText(formattedText, start, end, 'select');
      if (!selected) textarea.setSelectionRange(start + marker.length, start + marker.length + 4);
    }
    textarea.focus();
  }

  function handleAction(action, target) {
    var id = target.dataset.id;
    var record;
    switch (action) {
      case 'menu': document.querySelector('#sidebar').classList.toggle('mobile-open'); break;
      case 'collapse-sidebar': {
        var sidebar = document.querySelector('#sidebar');
        var collapsed = sidebar.classList.toggle('collapsed');
        state.preferences.sidebarCollapsed = collapsed;
        document.querySelector('.main-column').classList.toggle('sidebar-collapsed', collapsed);
        target.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        target.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        saveState();
        break;
      }
      case 'clear-global-search':
        globalSearch = '';
        if (currentPage === 'search') render();
        else document.querySelector('#global-search').value = '';
        document.querySelector('#global-search').focus();
        break;
      case 'open-notifications': setPage('notifications'); break;
      case 'search-reset':
        searchFilters = { type: 'all', subject: 'all', priority: 'all', status: 'all', due: 'all' };
        render();
        break;
      case 'deadline-reset':
        deadlineFilters = { type: 'all', subject: 'all', priority: 'all', status: 'incomplete' };
        render();
        break;
      case 'notifications-dismissed':
        showDismissedNotifications = !showDismissedNotifications;
        render();
        break;
      case 'notifications-read-all':
        state.notifications.forEach(function (item) {
          if (item.status === 'unread' && !item.dismissedAt) {
            item.status = 'read';
            item.readAt = new Date().toISOString();
          }
        });
        saveState();
        render();
        break;
      case 'notification-read':
        record = state.notifications.find(function (item) { return item.id === id; });
        if (record && record.status === 'unread') {
          record.status = 'read';
          record.readAt = new Date().toISOString();
          saveState();
          render();
        }
        break;
      case 'notification-dismiss':
        record = state.notifications.find(function (item) { return item.id === id; });
        if (record && !record.dismissedAt) {
          record.status = 'dismissed';
          record.dismissedAt = new Date().toISOString();
          saveState();
          render();
        }
        break;
      case 'theme':
        state.preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        saveState(); render(); break;
      case 'settings': case 'open-settings': setPage('settings'); break;
      case 'add-task': openForm('task'); break;
      case 'add-schedule': openForm('schedule'); break;
      case 'add-class': openForm('classSchedule'); break;
      case 'add-subject': openForm('subject'); break;
      case 'lesson-open-subject': lessonSubjectId = id; lessonSearch = ''; lessonStatusFilter = 'all'; lessonSort = 'order'; lessonIntroPending = true; render(); main.focus({ preventScroll: true }); break;
      case 'lesson-back': lessonSubjectId = ''; lessonSearch = ''; lessonIntroPending = true; render(); break;
      case 'lesson-add': lessonSubjectId = target.dataset.subject || lessonSubjectId; openForm('lesson', { subjectId: lessonSubjectId, lessonNumber: (state.lessons.filter(function (item) { return item.subjectId === lessonSubjectId; }).length + 1) }); break;
      case 'lesson-edit': record = getRecord('lessons', id); if (record) openForm('lesson', record); break;
      case 'lesson-delete':
        record = getRecord('lessons', id);
        if (record && window.confirm('Permanently delete "' + record.title + '" and its attached files? This cannot be undone.')) {
          state.lessons = state.lessons.filter(function (item) { return item.id !== id; });
          state.lessonAttachments = state.lessonAttachments.filter(function (file) { return file.lessonId !== id; });
          saveState(); render(); toast('Lesson and attached files deleted.');
        }
        break;
      case 'lesson-toggle-reviewed':
        record = getRecord('lessons', id);
        if (record) { record.reviewStatus = record.reviewStatus === 'Reviewed' ? 'Not Reviewed' : 'Reviewed'; record.updatedAt = new Date().toISOString(); saveState(); render(); }
        break;
      case 'lesson-move': {
        var orderedLessons = state.lessons.filter(function (item) { return item.subjectId === lessonSubjectId; }).sort(function (a, b) { return (Number(a.order) || Number(a.lessonNumber) || 0) - (Number(b.order) || Number(b.lessonNumber) || 0); });
        var oldIndex = orderedLessons.findIndex(function (item) { return item.id === id; });
        var newIndex = oldIndex + (target.dataset.direction === 'up' ? -1 : 1);
        if (oldIndex >= 0 && newIndex >= 0 && newIndex < orderedLessons.length) {
          var oldOrder = Number(orderedLessons[oldIndex].order) || oldIndex + 1;
          orderedLessons[oldIndex].order = Number(orderedLessons[newIndex].order) || newIndex + 1;
          orderedLessons[newIndex].order = oldOrder;
          saveState(); render();
        }
        break;
      }
      case 'lesson-clear-search': lessonSearch = ''; render(); break;
      case 'lesson-upload-files':
        var filePicker = document.querySelector('#lesson-file-input');
        filePicker.dataset.subjectId = target.dataset.subject || lessonSubjectId;
        filePicker.dataset.lessonId = target.dataset.lesson || '';
        filePicker.dataset.replaceId = '';
        filePicker.multiple = true;
        filePicker.click();
        break;
      case 'attachment-replace':
        var replacePicker = document.querySelector('#lesson-file-input');
        record = getRecord('lessonAttachments', id);
        if (record) {
          replacePicker.dataset.subjectId = record.subjectId;
          replacePicker.dataset.lessonId = record.lessonId || '';
          replacePicker.dataset.replaceId = id;
          replacePicker.multiple = false;
          replacePicker.click();
        }
        break;
      case 'attachment-open': record = getRecord('lessonAttachments', id); openLessonAttachment(record, false); break;
      case 'attachment-download': record = getRecord('lessonAttachments', id); openLessonAttachment(record, true); break;
      case 'attachment-delete':
        record = getRecord('lessonAttachments', id);
        if (record && window.confirm('Permanently delete "' + record.name + '" from this browser?')) {
          state.lessonAttachments = state.lessonAttachments.filter(function (file) { return file.id !== id; });
          saveState(); render(); toast('Attachment deleted.');
        }
        break;
      case 'lesson-note-format': formatLessonNotes(target); break;
      case 'add-flashcard': openForm('flashcard'); break;
      case 'add-assessment':
        record = target.dataset.subject ? { subjectId: target.dataset.subject } : null;
        if (!state.subjects.length) { toast('Add a subject before recording an assessment.', true); setPage('academics'); return; }
        openForm('assessment', record); break;
      case 'add-exam': openForm('exam'); break;
      case 'add-study': openForm('study'); break;
      case 'add-habit': openForm('habit'); break;
      case 'add-schedule-selected': closeModal(); openForm('schedule', { date: selectedDate }); break;
      case 'add-task-selected': closeModal(); openForm('task', { dueDate: selectedDate }); break;
      case 'add-exam-selected': closeModal(); openForm('exam', { date: selectedDate }); break;
      case 'add-study-selected': closeModal(); openForm('study', { date: selectedDate }); break;
      case 'add-calendar-item': addCalendarItem(); break;
      case 'edit-task': record = getRecord('tasks', id); if (record) openForm('task', record); break;
      case 'edit-schedule': record = getRecord('schedule', id); if (record) openForm('schedule', record); break;
      case 'edit-class': record = getRecord('classSchedules', id); if (record) openForm('classSchedule', record); break;
      case 'edit-subject': record = getRecord('subjects', id); if (record) openForm('subject', record); break;
      case 'edit-assessment': record = getRecord('assessments', id); if (record) openForm('assessment', record); break;
      case 'edit-exam': record = getRecord('exams', id); if (record) openForm('exam', record); break;
      case 'edit-study': record = getRecord('studySessions', id); if (record) openForm('study', record); break;
      case 'edit-habit': record = getRecord('habits', id); if (record) openForm('habit', record); break;
      case 'edit-flashcard': record = getRecord('flashcards', id); if (record) openForm('flashcard', record); break;
      case 'delete-task': deleteRecord('tasks', id, 'task'); break;
      case 'delete-schedule': deleteRecord('schedule', id, 'schedule block'); break;
      case 'delete-class': deleteRecord('classSchedules', id, 'class schedule'); break;
      case 'delete-subject': deleteRecord('subjects', id, 'subject'); break;
      case 'delete-assessment': deleteRecord('assessments', id, 'assessment'); break;
      case 'delete-exam': deleteRecord('exams', id, 'exam'); break;
      case 'delete-study': deleteRecord('studySessions', id, 'study session'); break;
      case 'delete-habit': deleteRecord('habits', id, 'habit'); break;
      case 'delete-flashcard': deleteRecord('flashcards', id, 'flashcard'); break;
      case 'flashcard-reveal':
        if (revealedFlashcards.has(id)) revealedFlashcards.delete(id);
        else revealedFlashcards.add(id);
        render();
        break;
      case 'archive-habit':
        record = getRecord('habits', id);
        if (record) { record.active = record.active === 'Archived' ? 'Active' : 'Archived'; saveState(); render(); toast(record.active === 'Archived' ? 'Habit archived.' : 'Habit restored.'); }
        break;
      case 'task-view': taskView = target.dataset.value; render(); break;
      case 'select-date': selectedDate = target.dataset.date; calendarDate = new Date(parseDate(selectedDate).getFullYear(), parseDate(selectedDate).getMonth(), 1); render(); break;
      case 'calendar-prev': calendarDate.setMonth(calendarDate.getMonth() - 1); render(); break;
      case 'calendar-next': calendarDate.setMonth(calendarDate.getMonth() + 1); render(); break;
      case 'calendar-today': selectedDate = todayKey(); calendarDate = new Date(); render(); break;
      case 'calendar-view': calendarView = target.dataset.value; render(); break;
      case 'schedule-today': selectedDate = todayKey(); render(); break;
      case 'schedule-prev': selectedDateChange(-1); break;
      case 'schedule-next': selectedDateChange(1); break;
      case 'schedule-tab': scheduleTab = target.dataset.value; render(); break;
      case 'academics-tab': academicsTab = target.dataset.value; render(); break;
      case 'timetable-view': timetableView = target.dataset.value; render(); break;
      case 'timetable-day': timetableDay = Number(target.dataset.day); timetableView = 'day'; render(); break;
      case 'timetable-prev': timetableWeekOffset -= 1; render(); break;
      case 'timetable-next': timetableWeekOffset += 1; render(); break;
      case 'timetable-today': timetableWeekOffset = 0; timetableDay = new Date().getDay(); render(); break;
      case 'progress-range': progressRange = target.dataset.value; render(); break;
      case 'apply-range': render(); break;
      case 'quote': state.quoteIndex += 1; saveState(); render(); break;
      case 'toggle-task': toggleTask(id, target.checked); break;
      case 'toggle-habit': toggleHabit(id, target.dataset.date, target.checked); break;
      case 'toggle-study': markStudyComplete(id); break;
      case 'timer-start': startTimer(); render(); runTimer(); break;
      case 'timer-pause': pauseTimer(); break;
      case 'timer-reset': resetTimer(); break;
      case 'timer-skip': skipTimer(); break;
      case 'close-modal': closeModal(); break;
      case 'export': exportData(); break;
      case 'import-backup': document.querySelector('#import-backup-file').click(); break;
      case 'clear-data':
        clearAllData();
        break;
      case 'notifications':
        if (!('Notification' in window)) { toast('Browser notifications are not supported here. In-app reminders remain available.', true); break; }
        if (Notification.permission === 'granted') { state.preferences.notifications = !state.preferences.notifications; saveState(); render(); toast(state.preferences.notifications ? 'Browser notifications enabled.' : 'Browser notifications disabled.'); }
        else if (Notification.permission === 'denied') toast('Notifications are blocked in browser settings. In-app reminders remain available.', true);
        else Notification.requestPermission().then(function (permission) {
          state.preferences.notifications = permission === 'granted';
          saveState(); render();
          toast(permission === 'granted' ? 'Browser notifications enabled.' : 'Notification permission was not granted.');
        }).catch(function (error) {
          console.error('Unable to request browser notification permission.', error);
          toast('Browser notification permission could not be requested. In-app reminders remain available.', true);
        });
        break;
    }
  }

  function checkReminders() {
    var now = Date.now();
    var dueReminders = state.notifications.filter(function (item) {
      return item.status === 'scheduled' && !item.dismissedAt && item.remindAt <= now;
    });
    if (!dueReminders.length) return;
    dueReminders.forEach(function (item) {
      item.status = 'unread';
      item.deliveredAt = new Date(now).toISOString();
      toast('Reminder: ' + item.title);
      if (state.preferences.notifications && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification('My PeOr reminder', { body: item.title });
        } catch (error) {
          console.error('Unable to display browser reminder.', error);
          toast('A browser reminder could not be displayed; it is available in the in-app notification center.', true);
        }
      }
    });
    saveState();
    updateNotificationBadges();
    if (currentPage === 'notifications') render();
  }

  document.querySelector('#sidebar').addEventListener('click', function (event) {
    var pageButton = event.target.closest('[data-page]');
    if (pageButton) {
      setPage(pageButton.dataset.page);
      return;
    }
    var actionTarget = event.target.closest('[data-action]');
    if (actionTarget) handleAction(actionTarget.dataset.action, actionTarget);
  });

  document.querySelector('.topbar').addEventListener('click', function (event) {
    var pageLink = event.target.closest('[data-page-link]');
    if (pageLink) setPage(pageLink.dataset.pageLink);
    var actionTarget = event.target.closest('[data-action]');
    if (actionTarget) handleAction(actionTarget.dataset.action, actionTarget);
  });

  document.querySelector('.topbar').addEventListener('input', function (event) {
    if (event.target.id !== 'global-search') return;
    globalSearch = event.target.value;
    currentPage = 'search';
    render();
    var input = document.querySelector('#global-search');
    input.focus();
    input.setSelectionRange(globalSearch.length, globalSearch.length);
  });

  document.querySelector('.mobile-bottom-nav').addEventListener('click', function (event) {
    var button = event.target.closest('[data-page]');
    if (button) setPage(button.dataset.page);
  });

  document.querySelector('#import-backup-file').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importBackup(file);
  });

  document.querySelector('#lesson-file-input').addEventListener('change', async function (event) {
    var picker = event.target;
    var files = Array.prototype.slice.call(picker.files || []);
    var subjectId = picker.dataset.subjectId;
    var lessonId = picker.dataset.lessonId;
    var replaceId = picker.dataset.replaceId;
    picker.value = '';
    picker.dataset.subjectId = '';
    picker.dataset.lessonId = '';
    picker.dataset.replaceId = '';
    try {
      await saveLessonFiles(files, subjectId, lessonId, replaceId);
    } catch (error) {
      console.error('Unable to add lesson attachment.', error);
      toast(error && error.message ? error.message : 'The selected file could not be saved.', true);
    }
  });

  main.addEventListener('click', function (event) {
    var pageLink = event.target.closest('[data-page-link]');
    if (pageLink) { setPage(pageLink.dataset.pageLink); return; }
    var target = event.target.closest('[data-action]');
    if (target && target.tagName !== 'INPUT') handleAction(target.dataset.action, target);
  });

  main.addEventListener('change', function (event) {
    var target = event.target;
    if (target.closest('[data-form="settings"]')) {
      if (savePreferences(target.form, true)) render();
      return;
    }
    if (target.matches('[data-action="toggle-task"], [data-action="toggle-habit"]')) {
      handleAction(target.dataset.action, target);
      return;
    }
    if (target.name === 'task-category') { taskCategoryFilter = target.value; render(); }
    if (target.name === 'task-priority') { taskPriorityFilter = target.value; render(); }
    if (target.name === 'task-sort') { taskSort = target.value; render(); }
    if (target.name === 'search-type') { searchFilters.type = target.value; render(); }
    if (target.name === 'search-subject') { searchFilters.subject = target.value; render(); }
    if (target.name === 'search-priority') { searchFilters.priority = target.value; render(); }
    if (target.name === 'search-status') { searchFilters.status = target.value; render(); }
    if (target.name === 'search-due') { searchFilters.due = target.value; render(); }
    if (target.name === 'deadline-type') { deadlineFilters.type = target.value; render(); }
    if (target.name === 'deadline-subject') { deadlineFilters.subject = target.value; render(); }
    if (target.name === 'deadline-priority') { deadlineFilters.priority = target.value; render(); }
    if (target.name === 'deadline-status') { deadlineFilters.status = target.value; render(); }
    if (target.name === 'lesson-status') { lessonStatusFilter = target.value; render(); }
    if (target.name === 'lesson-sort') { lessonSort = target.value; render(); }
    if (target.name === 'schedule-date' || target.name === 'calendar-date') {
      selectedDate = target.value || todayKey();
      if (target.name === 'calendar-date') {
        var chosenDate = parseDate(selectedDate);
        calendarDate = new Date(chosenDate.getFullYear(), chosenDate.getMonth(), 1);
      }
      render();
    }
    if (target.name === 'timetable-start' || target.name === 'timetable-end') {
      var startHour = target.name === 'timetable-start' ? Number(target.value) : state.timetablePreferences.startHour;
      var endHour = target.name === 'timetable-end' ? Number(target.value) : state.timetablePreferences.endHour;
      if (endHour <= startHour) {
        toast('The timetable end time must be later than its start time.', true);
        render();
        return;
      }
      state.timetablePreferences = { startHour: startHour, endHour: endHour };
      saveState();
      render();
    }
  });

  main.addEventListener('input', function (event) {
    if (event.target.closest('[data-form="settings"]')) {
      window.clearTimeout(settingsSaveTimer);
      settingsSaveTimer = window.setTimeout(function () {
        if (savePreferences(event.target.form, false) && event.target.form.dataset.form === 'settings') {
          if (currentPage === 'dashboard' && event.target.name === 'name') render();
        }
      }, 250);
      return;
    }
    if (event.target.name === 'task-search') {
      var position = event.target.selectionStart;
      taskSearch = event.target.value;
      render();
      var search = main.querySelector('[name="task-search"]');
      search.focus();
      search.setSelectionRange(position, position);
    }
    if (event.target.name === 'lesson-search') {
      var lessonPosition = event.target.selectionStart;
      lessonSearch = event.target.value;
      render();
      var lessonSearchInput = main.querySelector('[name="lesson-search"]');
      lessonSearchInput.focus();
      lessonSearchInput.setSelectionRange(lessonPosition, lessonPosition);
    }
    if (event.target.name === 'range-start') customRange.start = event.target.value;
    if (event.target.name === 'range-end') customRange.end = event.target.value;
  });

  main.addEventListener('submit', function (event) {
    if (event.target.matches('[data-form="settings"]')) {
      event.preventDefault();
      if (savePreferences(event.target, true)) {
        render();
      }
      return;
    }
    if (event.target.matches('[data-form]')) {
      event.preventDefault();
      saveForm(event.target);
    }
  });

  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeModal();
    var target = event.target.closest('[data-action]');
    if (target) handleAction(target.dataset.action, target);
  });

  modal.addEventListener('submit', function (event) {
    if (event.target.matches('[data-form]')) {
      event.preventDefault();
      saveForm(event.target);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.timer.status === 'running') {
      if (state.timer.endAt <= Date.now()) completeTimer();
      else render();
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (storageStatus !== 'saving') return;
    event.preventDefault();
    event.returnValue = '';
  });

  async function init() {
    document.querySelector('.app-shell').inert = true;
    document.querySelector('.mobile-bottom-nav').inert = true;
    setStorageStatus('loading');
    await loadState();
    document.querySelector('.app-shell').inert = false;
    document.querySelector('.mobile-bottom-nav').inert = false;
    selectedDate = todayKey();
    calendarDate = parseDate(selectedDate);
    if (!state.timer.remainingMs || state.timer.status === 'idle') state.timer.remainingMs = getPhaseMinutes() * 60000;
    render();
    checkReminders();
    if (state.timer.status === 'running') runTimer();
    window.setInterval(function () {
      checkReminders();
      var focusedControl = document.activeElement && document.activeElement.matches('input, select, textarea');
      if (currentPage === 'deadlines' && !focusedControl) render();
    }, 30000);
  }

  init().catch(function (error) {
    setStorageStatus('error', error && error.message ? error.message : 'My PeOr could not load its saved data.');
    console.error('Unable to start My PeOr.', error);
  });
}());
