(function () {
  'use strict';

  var STORAGE_KEY = 'mypeor.local.v1';
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
      tasks: [], schedule: [], subjects: [], assessments: [], exams: [], studySessions: [], habits: [], habitLogs: [],
      preferences: { name: '', theme: 'system', timezone: 'Asia/Manila', dateFormat: 'medium', timeFormat: '12h', focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, notifications: false },
      timer: { phase: 'focus', status: 'idle', endAt: null, remainingMs: 25 * 60000, focusCount: 0, completedSessions: [] },
      quoteIndex: 0,
      dismissedReminders: [],
      demoMode: false
    };
  };

  var state = freshState();
  var currentPage = 'dashboard';
  var taskView = 'all';
  var taskSearch = '';
  var taskCategoryFilter = 'all';
  var taskPriorityFilter = 'all';
  var taskSort = 'due';
  var calendarDate = parseDate(todayKey());
  var calendarView = 'month';
  var selectedDate = todayKey();
  var progressRange = 'week';
  var customRange = { start: todayKey(), end: todayKey() };
  var timerInterval = null;
  var storageAvailable = true;

  var main = document.querySelector('#main-content');
  var modal = document.querySelector('#modal');
  var modalBody = document.querySelector('#modal-body');
  var modalTitle = document.querySelector('#modal-title');
  var modalReturnFocus = null;

  function loadState() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        var parsed = JSON.parse(saved);
        var base = freshState();
        Object.keys(base).forEach(function (key) {
          if (parsed[key] !== undefined) base[key] = parsed[key];
        });
        base.preferences = Object.assign(freshState().preferences, parsed.preferences || {});
        base.timer = Object.assign(freshState().timer, parsed.timer || {});
        state = base;
      }
    } catch (error) {
      storageAvailable = false;
      console.error('Unable to load My PeOr browser data.', error);
    }

    if (state.timer.status === 'running' && state.timer.endAt && state.timer.endAt <= Date.now()) {
      state.timer.status = 'paused';
      state.timer.remainingMs = 0;
      state.timer.endAt = null;
      state.timer.recoveredExpired = true;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
      return true;
    } catch (error) {
      storageAvailable = false;
      console.error('Unable to save My PeOr browser data.', error);
      toast('Could not save changes to this browser. Check storage permissions or available space.', true);
      return false;
    }
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
    var date = new Date();
    date.setHours(Number(parts[0]), Number(parts[1] || 0), 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hour12: state.preferences.timeFormat !== '24h' }).format(date);
  }

  function dateTimeLabel(value) {
    if (!value) return '';
    var date = new Date(zonedDateTimeToEpoch(value));
    if (isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
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
    if (days === 0) return task.dueTime ? 'Today at ' + timeLabel(task.dueTime) : 'Due today';
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

  function toast(message, isError) {
    var region = document.querySelector('#toast-region');
    var node = document.createElement('div');
    node.className = 'toast' + (isError ? ' error' : '');
    node.textContent = message;
    region.appendChild(node);
    window.setTimeout(function () { node.remove(); }, 3600);
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
    if (type === 'textarea') {
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
    var body = '<form data-form="' + type + '" data-id="' + escapeHtml(values.id || '') + '" novalidate><div class="form-grid">' +
      fields.map(function (item) { return field(item.label, item.name, item.type, values[item.name] != null ? values[item.name] : item.value, item); }).join('') +
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
        { label: 'Reminder', name: 'reminderAt', type: 'datetime-local', hint: 'In-app reminders are available while this page is open.' },
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
        { label: 'Description', name: 'description', type: 'textarea', full: true }
      ];
    } else if (type === 'subject') {
      title = id ? 'Edit subject' : 'Add subject';
      fields = [
        { label: 'Subject name', name: 'name', type: 'text', required: true },
        { label: 'Subject code', name: 'code', type: 'text' },
        { label: 'Instructor', name: 'instructor', type: 'text' },
        { label: 'Semester / period', name: 'period', type: 'text' },
        { label: 'Target grade (%)', name: 'target', type: 'number', min: 0, max: 100, step: 'any' },
        { label: 'Description', name: 'description', type: 'textarea', full: true }
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
        { label: 'Notes', name: 'notes', type: 'textarea', full: true }
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
        { label: 'Notes', name: 'notes', type: 'textarea', full: true }
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
    openModal(title, formFrame(type, record, fields), 'input:not([type="hidden"]), select');
  }

  function taskMarkup(task, withActions) {
    var status = statusForTask(task);
    var subject = task.subjectId ? subjectName(task.subjectId) : '';
    return '<div class="task-row"><input class="check" type="checkbox" data-action="toggle-task" data-id="' + escapeHtml(task.id) + '" aria-label="Mark ' + escapeHtml(task.title) + ' completed"' + (task.status === 'Completed' ? ' checked' : '') + '>' +
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
    return '<div class="empty-state"><strong>' + escapeHtml(title) + '</strong>' + escapeHtml(text) + (action ? '<div style="margin-top:12px"><button class="button subtle" data-action="' + action + '">' + escapeHtml(label || 'Get started') + '</button></div>' : '') + '</div>';
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
    var upcoming = state.tasks.filter(function (task) {
      return task.status !== 'Completed' && task.dueDate && dayDifference(task.dueDate) >= 0 && dayDifference(task.dueDate) <= 7;
    }).length + state.exams.filter(function (exam) { return dayDifference(exam.date) >= 0 && dayDifference(exam.date) <= 7; }).length;
    var habits = todaysHabits();
    var doneHabits = habits.filter(function (habit) { return habitDone(habit.id, today); }).length;
    var focusToday = completedStudyMinutes(today, today);
    var percent = todays.length ? Math.round(completed / todays.length * 100) : 0;
    var deadlines = state.tasks.filter(function (task) { return task.dueDate && task.status !== 'Completed' && dayDifference(task.dueDate) >= -7 && dayDifference(task.dueDate) <= 7; }).map(function (task) {
      return { id: task.id, title: task.title, date: task.dueDate, time: task.dueTime || '', kind: 'task', status: statusForTask(task), hint: dueHint(task) };
    }).concat(state.exams.filter(function (exam) { return exam.date && dayDifference(exam.date) >= 0 && dayDifference(exam.date) <= 7; }).map(function (exam) {
      return { id: exam.id, title: exam.title, date: exam.date, time: exam.time || '', kind: 'exam', status: dayDifference(exam.date) === 0 ? 'Due Today' : 'Upcoming', hint: subjectName(exam.subjectId) || 'Exam' };
    })).sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); }).slice(0, 5);
    var schedule = state.schedule.filter(function (item) { return item.date === today; }).sort(function (a, b) { return a.startTime.localeCompare(b.startTime); }).slice(0, 4);
    var quoteList = [
      { text: 'Great things are done by a series of small things brought together.', author: 'Vincent van Gogh' },
      { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
      { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
      { text: 'Learning never exhausts the mind.', author: 'Leonardo da Vinci' }
    ];
    var quote = quoteList[state.quoteIndex % quoteList.length];
    var notice = storageAvailable ? '<div class="notice warning" style="margin-bottom:18px"><strong>Local demo mode.</strong> Your data is saved in this browser only. Sign-in and cross-device cloud sync are not configured. See Settings for the backend setup required.' + (state.demoMode ? ' Sample records are loaded and marked as demo data; remove them from Settings at any time.' : '') + '</div>' :
      '<div class="notice error" style="margin-bottom:18px">Browser storage is unavailable. Changes may not persist after this page is closed.</div>';

    return notice +
      '<div class="welcome-row"><div><p class="eyebrow">Your overview</p><h1 class="greeting">' + currentTimeGreeting() + (state.preferences.name ? ', ' + escapeHtml(state.preferences.name) : '') + '</h1><p class="greeting-sub">Let’s make today productive.</p>' +
      '<div class="progress-line"><span>Daily progress</span><span class="progress-track"><span class="progress-fill" style="display:block;width:' + percent + '%"></span></span><span>' + percent + '%</span></div></div><div class="date-label">' + escapeHtml(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(parseDate(today))) + '</div></div>' +
      '<section class="summary-grid">' +
      summaryCard('Tasks Today', completed + ' / ' + todays.length, remaining + ' remaining', '☷') +
      summaryCard('Upcoming Deadlines', String(upcoming), 'Due within 7 days', '◷') +
      summaryCard('Study Time', formatMinutes(focusToday), 'Recorded completed study time today', '◎') +
      summaryCard('Habit Progress', doneHabits + ' / ' + habits.length, 'Habits completed today', '✓') + '</section>' +
      '<div class="dashboard-grid"><div class="stack">' +
      '<section class="card"><div class="card-title-row"><h2>Today’s tasks</h2><button class="text-button" data-page-link="tasks">View all</button></div>' +
      (todays.length ? '<div class="task-list">' + todays.sort(function (a, b) { return (a.dueTime || '').localeCompare(b.dueTime || ''); }).map(function (task) { return taskMarkup(task, false); }).join('') + '</div>' : emptyState('You’re all caught up.', 'Add a task to get started.', 'add-task', 'Add a task')) + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>Daily schedule</h2><button class="text-button" data-page-link="schedule">Open schedule</button></div>' +
      (schedule.length ? schedule.map(function (item) { return '<div class="schedule-row"><span class="summary-icon">◷</span><div class="row-info"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(timeLabel(item.startTime)) + ' – ' + escapeHtml(timeLabel(item.endTime)) + (item.subjectId ? ' · ' + escapeHtml(subjectName(item.subjectId)) : '') + '</small></div></div>'; }).join('') : emptyState('No schedule for today.', 'Add a block to plan your routine.', 'add-schedule', 'Add schedule block')) + '</section></div>' +
      '<div class="stack"><section class="card"><div class="card-title-row"><h2>Upcoming deadlines</h2><span class="muted">Tasks &amp; exams</span></div>' +
      (deadlines.length ? deadlines.map(function (item) { return '<button class="deadline-row text-button w-100" data-action="' + (item.kind === 'exam' ? 'edit-exam' : 'edit-task') + '" data-id="' + escapeHtml(item.id) + '"><span class="deadline-date"><strong>' + escapeHtml(parseDate(item.date).getDate()) + '</strong>' + escapeHtml(parseDate(item.date).toLocaleDateString(undefined, { month: 'short' })) + '</span><span class="row-info"><strong>' + escapeHtml(item.title) + '</strong><small>' + escapeHtml(item.hint) + (item.time ? ' · ' + escapeHtml(timeLabel(item.time)) : '') + '</small></span><span class="status-pill ' + statusClass(item.status) + '">' + escapeHtml(item.status) + '</span></button>'; }).join('') : emptyState('No upcoming deadlines.', 'You have a clear week ahead.')) + '</section>' +
      '<section class="card quote-card"><div class="card-title-row"><h2>A little inspiration</h2><button class="icon-button quote-refresh" data-action="quote" aria-label="Show another quote" title="Show another quote">↻</button></div><p class="quote-text">“' + escapeHtml(quote.text) + '”</p><p class="quote-author">— ' + escapeHtml(quote.author) + '</p></section>' +
      timerWidget() + '</div></div>';
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

  function renderCalendar() {
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
    return pageHeading('Calendar', 'Your tasks, exams, study sessions, and schedule in one view.', '<button class="button" data-action="calendar-today">Today</button><button class="button primary" data-action="add-calendar-item">＋ Add to date</button>') +
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
    var action = event.kind === 'task' ? 'edit-task' : event.kind === 'schedule' ? 'edit-schedule' : event.kind === 'exam' ? 'edit-exam' : event.kind === 'habit' ? 'edit-habit' : 'edit-study';
    return '<button class="schedule-row text-button w-100" data-action="' + action + '" data-id="' + escapeHtml(event.id) + '"><span class="summary-icon">' + (event.kind === 'exam' ? '◇' : event.kind === 'schedule' ? '◷' : event.kind === 'study' ? '◎' : '☷') + '</span><span class="row-info"><strong>' + escapeHtml(event.title) + '</strong><small>' + escapeHtml(hasDate ? dateLabel(event.date) + ' · ' : '') + escapeHtml(event.time ? timeLabel(event.time) : event.kind) + '</small></span><span class="calendar-event ' + event.type + '">' + escapeHtml(event.kind) + '</span></button>';
  }

  function renderSchedule() {
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
    return pageHeading('Daily Schedule', 'Build a realistic routine and see how your day fits together.', '<button class="button" data-action="schedule-today">Today</button><button class="button primary" data-action="add-schedule">＋ Add block</button>') +
      '<section class="card"><div class="calendar-top"><div class="heading-actions"><button class="icon-button" data-action="schedule-prev" aria-label="Previous day">‹</button><strong class="calendar-title">' + escapeHtml(dateObject.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })) + '</strong><button class="icon-button" data-action="schedule-next" aria-label="Next day">›</button></div><input style="width:auto" type="date" name="schedule-date" value="' + escapeHtml(selectedDate) + '" aria-label="Schedule date"></div>' +
      '<div class="notice info" style="margin-bottom:14px">Schedule is stored locally. Overlapping activities are flagged so you can adjust them.</div>' +
      (items.length ? '<div class="timeline">' + timeline + '</div>' : emptyState('No schedule created for this day.', 'Plan classes, focused study, breaks, and personal time.', 'add-schedule', 'Add schedule block')) + '</section>';
  }

  function renderSubjects() {
    var assessments = state.assessments.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var subjectCards = state.subjects.map(function (subject) {
      var records = assessments.filter(function (item) { return item.subjectId === subject.id; });
      var avg = records.length ? records.reduce(function (sum, item) { return sum + item.score / item.maximum * 100; }, 0) / records.length : null;
      var weightedRecords = records.filter(function (item) { return item.weight !== '' && item.weight != null && Number(item.weight) > 0; });
      var weightTotal = weightedRecords.reduce(function (sum, item) { return sum + Number(item.weight); }, 0);
      var allHaveWeights = records.length > 0 && weightedRecords.length === records.length;
      var weighted = allHaveWeights && Math.abs(weightTotal - 100) < .001 ? weightedRecords.reduce(function (sum, item) { return sum + item.score / item.maximum * Number(item.weight); }, 0) / 100 : null;
      var gradeDisplay = avg == null ? 'No grades recorded yet' : 'Recorded average: ' + avg.toFixed(1) + '%';
      var weightingNote = weighted == null ? (weightedRecords.length ? '<p class="small-note">Weighted estimate unavailable: recorded weights total ' + weightTotal + '%, not 100%.</p>' : '<p class="small-note">No configured weights; average is an unweighted percentage.</p>') : '<p class="small-note">Weighted estimate: ' + weighted.toFixed(1) + '% (weights total 100%).</p>';
      return '<article class="card"><div class="card-title-row"><h3>' + escapeHtml(subject.name) + '</h3><div class="table-actions"><button class="icon-button" data-action="edit-subject" data-id="' + escapeHtml(subject.id) + '" aria-label="Edit subject">✎</button><button class="icon-button" data-action="delete-subject" data-id="' + escapeHtml(subject.id) + '" aria-label="Delete subject">×</button></div></div>' +
        '<p class="small-note">' + escapeHtml([subject.code, subject.instructor, subject.period].filter(Boolean).join(' · ') || 'Subject details can be added in edit.') + '</p><div class="inline-stat"><strong>' + (avg == null ? '—' : avg.toFixed(1) + '%') + '</strong><span class="muted">' + gradeDisplay + '</span></div>' + weightingNote +
        '<button class="text-button" data-action="add-assessment" data-subject="' + escapeHtml(subject.id) + '">＋ Record assessment</button>' +
        (records.length ? '<div class="task-list" style="margin-top:10px">' + records.slice(0, 4).map(assessmentRow).join('') + '</div>' : '') + '</article>';
    }).join('');
    return pageHeading('Subjects & Grades', 'Keep subjects, assessments, and recorded scores together.', '<button class="button" data-action="add-assessment">＋ Record grade</button><button class="button primary" data-action="add-subject">＋ Add subject</button>') +
      (!state.subjects.length ? emptyState('No subjects yet.', 'Create your first subject to organize your academic progress.', 'add-subject', 'Add a subject') : '<div class="section-grid">' + subjectCards + '</div>') +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Assessment records</h2><span class="muted">' + assessments.length + ' recorded</span></div>' +
      (assessments.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Assessment</th><th>Subject</th><th>Score</th><th>Percentage</th><th>Date</th><th></th></tr></thead><tbody>' + assessments.map(function (item) { return '<tr><td>' + escapeHtml(item.name) + '</td><td>' + escapeHtml(subjectName(item.subjectId) || '—') + '</td><td>' + escapeHtml(item.score) + ' / ' + escapeHtml(item.maximum) + '</td><td>' + (item.maximum ? (item.score / item.maximum * 100).toFixed(1) + '%' : '—') + '</td><td>' + escapeHtml(dateLabel(item.date)) + '</td><td><div class="table-actions"><button class="icon-button" data-action="edit-assessment" data-id="' + escapeHtml(item.id) + '" aria-label="Edit assessment">✎</button><button class="icon-button" data-action="delete-assessment" data-id="' + escapeHtml(item.id) + '" aria-label="Delete assessment">×</button></div></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No grades recorded yet.', 'Add an assessment to begin tracking scores.')) + '</section>';
  }

  function assessmentRow(item) {
    return '<div class="simple-row"><span class="row-info"><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(dateLabel(item.date)) + ' · ' + escapeHtml(item.score) + '/' + escapeHtml(item.maximum) + '</small></span><span class="status-pill">' + (item.maximum ? (item.score / item.maximum * 100).toFixed(0) + '%' : '—') + '</span></div>';
  }

  function renderPlanner() {
    var exams = state.exams.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var sessions = state.studySessions.slice().sort(function (a, b) { return (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')); });
    return pageHeading('Exams & Study Planner', 'Prepare across the semester with manageable study sessions.', '<button class="button" data-action="add-study">＋ Plan study</button><button class="button primary" data-action="add-exam">＋ Add exam</button>') +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Upcoming exams</h2><span class="muted">' + exams.filter(function (exam) { return dayDifference(exam.date) >= 0; }).length + ' upcoming</span></div>' +
      (exams.length ? exams.map(function (exam) { var days = dayDifference(exam.date); return '<div class="simple-row"><span class="deadline-date"><strong>' + escapeHtml(parseDate(exam.date).getDate()) + '</strong>' + escapeHtml(parseDate(exam.date).toLocaleDateString(undefined, { month: 'short' })) + '</span><span class="row-info"><strong>' + escapeHtml(exam.title) + (exam.demo ? ' · Demo' : '') + '</strong><small>' + escapeHtml(subjectName(exam.subjectId) || 'No subject') + (exam.time ? ' · ' + escapeHtml(timeLabel(exam.time)) : '') + ' · ' + escapeHtml(days < 0 ? 'Past' : days === 0 ? 'Today' : 'In ' + days + ' days') + '</small></span><span class="status-pill">' + escapeHtml(exam.prepStatus) + '</span><span class="table-actions"><button class="icon-button" data-action="edit-exam" data-id="' + escapeHtml(exam.id) + '" aria-label="Edit exam">✎</button><button class="icon-button" data-action="delete-exam" data-id="' + escapeHtml(exam.id) + '" aria-label="Delete exam">×</button></span></div>'; }).join('') : emptyState('No exams scheduled yet.', 'Add your next quiz or examination.', 'add-exam', 'Add an exam')) + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>Focus timer</h2><span class="muted">Pomodoro</span></div>' + timerWidget(true) + '<button class="text-button" data-action="open-settings">Adjust focus and break durations in Settings</button></section></div>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Planned study sessions</h2><button class="button" data-action="add-study">＋ Plan session</button></div>' +
      (sessions.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Topic</th><th>Subject</th><th>Date &amp; time</th><th>Planned</th><th>Status</th><th></th></tr></thead><tbody>' + sessions.map(function (session) { return '<tr><td>' + escapeHtml(session.topic) + '<div class="small-note">' + escapeHtml(session.notes || '') + '</div></td><td>' + escapeHtml(subjectName(session.subjectId) || '—') + '</td><td>' + escapeHtml(dateLabel(session.date)) + (session.startTime ? ' · ' + escapeHtml(timeLabel(session.startTime)) : '') + '</td><td>' + escapeHtml(session.plannedMinutes || 0) + ' min' + (session.actualMinutes ? ' · ' + escapeHtml(session.actualMinutes) + ' actual' : '') + '</td><td><span class="status-pill ' + (session.status === 'Completed' ? 'status-completed' : 'status-upcoming') + '">' + escapeHtml(session.status) + '</span></td><td><div class="table-actions"><button class="icon-button" data-action="toggle-study" data-id="' + escapeHtml(session.id) + '" aria-label="Toggle study completion">' + (session.status === 'Completed' ? '↶' : '✓') + '</button><button class="icon-button" data-action="edit-study" data-id="' + escapeHtml(session.id) + '" aria-label="Edit session">✎</button><button class="icon-button" data-action="delete-study" data-id="' + escapeHtml(session.id) + '" aria-label="Delete session">×</button></div></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No study sessions planned.', 'Plan your first focused session across the days before an exam.', 'add-study', 'Plan a study session')) + '</section>';
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
    return '<div class="timer-card' + (compact ? ' compact' : '') + '"><div class="timer-ring" style="--timer-progress:' + progress + '%"><div class="timer-inner"><span class="timer-label">' + label + '</span><strong class="timer-time">' + min + ':' + sec + '</strong></div></div>' +
      (timer.recoveredExpired ? '<p class="small-note danger-text">The timer expired while the page was away. It was not counted as a completed session.</p>' : '') +
      '<p class="small-note">Completed focus sessions: ' + timer.focusCount + '</p><div class="timer-actions">' +
      (timer.status === 'running' ? '<button class="button" data-action="timer-pause">Pause</button>' : '<button class="button primary" data-action="timer-start">' + (timer.status === 'paused' ? 'Resume' : 'Start') + '</button>') +
      '<button class="button" data-action="timer-reset">Reset</button><button class="button" data-action="timer-skip">Skip</button></div></div>';
  }

  function renderHabits() {
    var habits = todaysHabits();
    var today = todayKey();
    var start = parseDate(today);
    start.setDate(start.getDate() - start.getDay());
    var weekDays = Array.from({ length: 7 }, function (_, index) { var date = new Date(start); date.setDate(date.getDate() + index); return localDate(date); });
    return pageHeading('Habits', 'Small routines add up. Keep building at your own pace.', '<button class="button primary" data-action="add-habit">＋ Add habit</button>') +
      '<div class="notice info" style="margin-bottom:16px">Every new day is another chance to build a good habit.</div>' +
      '<section class="card"><div class="card-title-row"><h2>Today’s habits</h2><span class="muted">' + habits.filter(function (habit) { return habitDone(habit.id, today); }).length + ' of ' + habits.length + ' complete</span></div>' +
      (habits.length ? habits.map(function (habit) {
        var logs = state.habitLogs.filter(function (log) { return log.habitId === habit.id; });
        var streak = habitStreak(habit);
        return '<div class="simple-row"><label class="habit-check"><input type="checkbox" data-action="toggle-habit" data-id="' + escapeHtml(habit.id) + '" data-date="' + today + '"' + (habitDone(habit.id, today) ? ' checked' : '') + '><span class="row-info"><strong>' + escapeHtml(habit.name) + '</strong><small>' + escapeHtml(habit.description || habit.frequency + (habit.frequency === 'Weekly' ? ' · target ' + (habit.weeklyTarget || 3) + ' days/week' : '')) + '</small></span></label><span class="streak">↗ ' + streak + ' ' + (habit.frequency === 'Weekly' ? 'weeks' : 'day streak') + '</span><div class="table-actions"><button class="icon-button" data-action="edit-habit" data-id="' + escapeHtml(habit.id) + '" aria-label="Edit habit">✎</button><button class="icon-button" data-action="archive-habit" data-id="' + escapeHtml(habit.id) + '" aria-label="Archive habit">⌑</button></div></div>';
      }).join('') : emptyState('No habits yet.', 'Start small. Add a habit you want to build.', 'add-habit', 'Add a habit')) + '</section>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>This week</h2><span class="muted">Saved completion history</span></div>' +
      (habits.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Habit</th>' + weekDays.map(function (day) { return '<th style="text-align:center">' + escapeHtml(parseDate(day).toLocaleDateString(undefined, { weekday: 'short' })) + '<br>' + escapeHtml(parseDate(day).getDate()) + '</th>'; }).join('') + '<th>Progress</th></tr></thead><tbody>' + habits.map(function (habit) { var count = weekDays.filter(function (day) { return habitDone(habit.id, day); }).length; return '<tr><td>' + escapeHtml(habit.name) + '</td>' + weekDays.map(function (day) { return '<td style="text-align:center"><input type="checkbox" data-action="toggle-habit" data-id="' + escapeHtml(habit.id) + '" data-date="' + day + '" aria-label="' + escapeHtml(habit.name + ' on ' + day) + '"' + (habitDone(habit.id, day) ? ' checked' : '') + '></td>'; }).join('') + '<td>' + count + ' / 7</td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('Habit history will appear here.', 'Add a habit, then check it off on the days you complete it.')) + '</section>';
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
    return pageHeading('Progress', 'A clear view of activity you have actually recorded.', '<div class="segmented"><button data-action="progress-range" data-value="week" class="' + (progressRange === 'week' ? 'selected' : '') + '">This week</button><button data-action="progress-range" data-value="month" class="' + (progressRange === 'month' ? 'selected' : '') + '">This month</button><button data-action="progress-range" data-value="custom" class="' + (progressRange === 'custom' ? 'selected' : '') + '">Custom</button></div>') +
      (progressRange === 'custom' ? '<div class="toolbar"><label>From <input type="date" name="range-start" value="' + escapeHtml(customRange.start) + '"></label><label>To <input type="date" name="range-end" value="' + escapeHtml(customRange.end) + '"></label><button class="button" data-action="apply-range">Apply</button></div>' : '') +
      '<section class="summary-grid">' + summaryCard('Tasks completed', String(tasksDone.length), 'Completed in selected range', '✓') + summaryCard('Tasks remaining', String(remaining), 'Due in selected range', '☷') + summaryCard('Overdue tasks', String(overdue), 'Currently incomplete', '◷') + summaryCard('Study time', formatMinutes(study), 'Recorded completed study time', '◎') + '</section>' +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Task activity</h2><span class="muted">Completed once per task</span></div><div class="bar-list">' +
      progressBar('Completed', tasksDone.length, maxTasks) + progressBar('Remaining', remaining, maxTasks) + progressBar('Overdue', overdue, maxTasks) +
      '</div></section><section class="card"><div class="card-title-row"><h2>Habits</h2><span class="muted">Recorded check-ins</span></div><div class="inline-stat"><strong>' + habitRate + '%</strong><span class="muted">completion rate</span></div><div class="progress-track" style="width:100%;margin:14px 0"><span class="progress-fill" style="display:block;width:' + habitRate + '%"></span></div><p class="small-note">' + logs + ' check-ins recorded across ' + habitTotal + ' active habits.</p></section></div>' +
      '<section class="section-grid" style="margin-top:16px"><article class="card"><div class="card-title-row"><h2>Focus sessions</h2></div><div class="inline-stat"><strong>' + state.timer.completedSessions.filter(function (session) { return session.phase === 'focus' && dateInConfiguredTimezone(new Date(session.completedAt)) >= from && dateInConfiguredTimezone(new Date(session.completedAt)) <= to; }).length + '</strong><span class="muted">completed in period</span></div><p class="small-note">Only completed focus sessions count. Planned study time is reported separately from those sessions.</p></article><article class="card"><div class="card-title-row"><h2>Academic assessments</h2></div>' + (subjectSummary ? '<div class="bar-list">' + subjectSummary + '</div><p class="small-note">Percentages use recorded scores; they are not official grades.</p>' : emptyState('No assessment data for this period.', 'Record assessment scores in Subjects & Grades.')) + '</article></section>';
  }

  function progressBar(label, value, max) {
    return '<div class="bar-item"><span>' + escapeHtml(label) + '</span><span class="progress-track"><span class="progress-fill" style="display:block;width:' + (value / max * 100) + '%"></span></span><strong>' + value + '</strong></div>';
  }

  function renderSettings() {
    var p = state.preferences;
    var reminders = state.tasks.filter(function (task) { return task.reminderAt && zonedDateTimeToEpoch(task.reminderAt) > Date.now() && task.status !== 'Completed'; }).sort(function (a, b) { return zonedDateTimeToEpoch(a.reminderAt) - zonedDateTimeToEpoch(b.reminderAt); });
    var permission = 'Not requested';
    if ('Notification' in window) permission = Notification.permission;
    return pageHeading('Settings', 'Personalize your organizer and manage local data.', '') +
      '<div class="section-grid"><section class="card"><div class="card-title-row"><h2>Profile &amp; preferences</h2></div>' +
      '<form data-form="settings" class="form-grid">' +
      settingsInput('Your name', 'name', p.name, 'text', 'Shown in your greeting') +
      settingsSelect('Theme', 'theme', p.theme, [['system', 'System default'], ['light', 'Light'], ['dark', 'Dark']]) +
      settingsInput('Timezone', 'timezone', p.timezone, 'text', 'Example: Asia/Manila') +
      settingsSelect('Date format', 'dateFormat', p.dateFormat, [['medium', 'MMM D, YYYY'], ['short', 'MM/DD/YYYY'], ['iso', 'YYYY-MM-DD']]) +
      settingsSelect('Time format', 'timeFormat', p.timeFormat, [['12h', '12-hour'], ['24h', '24-hour']]) +
      settingsInput('Focus duration (minutes)', 'focusMinutes', p.focusMinutes, 'number', '', 1) +
      settingsInput('Short break (minutes)', 'shortBreakMinutes', p.shortBreakMinutes, 'number', '', 1) +
      settingsInput('Long break (minutes)', 'longBreakMinutes', p.longBreakMinutes, 'number', '', 1) +
      '<div class="form-field full"><button class="button primary" type="submit">Save preferences</button></div></form></section>' +
      '<div class="stack"><section class="card"><div class="card-title-row"><h2>Reminders &amp; notifications</h2><span class="status-pill">' + escapeHtml(permission) + '</span></div><p class="small-note">In-app reminders are checked while My PeOr is open. Browser notifications are optional and require your permission. There is no background notification service configured.</p>' +
      '<button class="button" data-action="notifications">' + (permission === 'granted' ? 'Browser notifications allowed' : 'Enable browser notifications') + '</button>' +
      (reminders.length ? '<div class="task-list" style="margin-top:12px">' + reminders.map(function (task) { return '<div class="simple-row"><span class="row-info"><strong>' + escapeHtml(task.title) + '</strong><small>' + escapeHtml(dateTimeLabel(task.reminderAt)) + '</small></span></div>'; }).join('') + '</div>' : '<p class="small-note">No upcoming reminders configured.</p>') + '</section>' +
      '<section class="card"><div class="card-title-row"><h2>Data &amp; account</h2></div><div class="notice warning"><strong>Cloud account is not configured.</strong> This site currently has no authentication provider or database. Browser data is not a secure account and is not synchronized to other devices.</div>' +
      '<div class="setting-row"><div><strong>Local demo data</strong><small>' + (state.demoMode ? 'Sample records are loaded. They are marked as demo data.' : 'No sample records loaded.') + '</small></div><button class="button" data-action="demo">' + (state.demoMode ? 'Remove demo data' : 'Try demo data') + '</button></div>' +
      '<div class="setting-row"><div><strong>Export data</strong><small>Download a JSON copy of this browser workspace.</small></div><button class="button" data-action="export">Export JSON</button></div>' +
      '<div class="setting-row"><div><strong>Clear all local data</strong><small>Deletes this browser workspace and preferences.</small></div><button class="button danger" data-action="clear-data">Clear data</button></div></section></div></div>' +
      '<section class="card" style="margin-top:16px"><div class="card-title-row"><h2>Cloud setup required</h2></div><p class="small-note">For secure sign-in and multi-device sync, connect a backend such as Supabase Auth + Postgres. Store only the public project URL and anon key in public configuration; enable Row Level Security and owner-based policies on every user table. Never put service-role keys in this frontend. Setup guidance is in README.md.</p></section>';
  }

  function settingsInput(label, name, value, type, hint, min) {
    return '<div class="form-field"><label for="setting-' + name + '">' + label + '</label><input id="setting-' + name + '" name="' + name + '" type="' + type + '" value="' + escapeHtml(value) + '"' + (min ? ' min="' + min + '"' : '') + '>' + (hint ? '<small class="form-hint">' + hint + '</small>' : '') + '</div>';
  }

  function settingsSelect(label, name, value, choices) {
    return '<div class="form-field"><label for="setting-' + name + '">' + label + '</label><select id="setting-' + name + '" name="' + name + '">' + choices.map(function (choice) { return '<option value="' + choice[0] + '"' + (value === choice[0] ? ' selected' : '') + '>' + choice[1] + '</option>'; }).join('') + '</select></div>';
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
    calendar: ['Calendar', renderCalendar],
    schedule: ['Daily Schedule', renderSchedule],
    subjects: ['Subjects & Grades', renderSubjects],
    planner: ['Exams & Study Planner', renderPlanner],
    habits: ['Habits', renderHabits],
    progress: ['Progress', renderProgress],
    settings: ['Settings', renderSettings]
  };

  function render() {
    if (!pages[currentPage]) currentPage = 'dashboard';
    document.querySelector('#current-section').textContent = pages[currentPage][0];
    document.querySelectorAll('.nav-item[data-page]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.page === currentPage);
      if (button.dataset.page === currentPage) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelector('#sidebar-name').textContent = state.preferences.name || 'My Organizer';
    document.querySelector('#sidebar-avatar').textContent = (state.preferences.name || 'M').trim().charAt(0).toUpperCase();
    applyTheme();
    main.innerHTML = pages[currentPage][1]();
  }

  function setPage(page) {
    if (!pages[page]) return;
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
    var data = Object.fromEntries(new FormData(form).entries());
    if (!validateForm(form)) return;
    var record;
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
    } else if (type === 'subject') {
      record = Object.assign({}, data, { id: id || makeId() });
      upsert('subjects', record);
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
    toast(id ? 'Changes saved.' : 'Added successfully.');
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
    if (!window.confirm('Delete this ' + label + '? This cannot be undone.')) return;
    state[collection] = state[collection].filter(function (item) { return item.id !== id; });
    if (collection === 'habits') state.habitLogs = state.habitLogs.filter(function (log) { return log.habitId !== id; });
    if (collection === 'subjects') {
      state.assessments = state.assessments.filter(function (item) { return item.subjectId !== id; });
      state.tasks.forEach(function (task) { if (task.subjectId === id) task.subjectId = ''; });
      state.schedule.forEach(function (item) { if (item.subjectId === id) item.subjectId = ''; });
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
    saveState();
    render();
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

  function loadDemo() {
    if (state.demoMode) {
      if (!window.confirm('Remove the sample demo records? This will only remove demo records.')) return;
      state.tasks = state.tasks.filter(function (item) { return !item.demo; });
      state.exams = state.exams.filter(function (item) { return !item.demo; });
      state.subjects = state.subjects.filter(function (item) { return !item.demo; });
      state.habits = state.habits.filter(function (item) { return !item.demo; });
      state.habitLogs = state.habitLogs.filter(function (item) { return !item.demo; });
      state.demoMode = false;
    } else {
      var demoSubject = { id: makeId(), name: 'Discrete Structures', code: 'CS 201', instructor: '', period: 'Sample data', description: '', demo: true };
      var codingSubject = { id: makeId(), name: 'Introduction to Programming', code: 'CS 101', instructor: '', period: 'Sample data', description: '', demo: true };
      state.subjects.push(demoSubject, codingSubject);
      state.tasks.push(
        { id: makeId(), title: 'Review Discrete Structures', description: 'Sample task — edit or remove it.', dueDate: todayKey(), dueTime: '', priority: 'Medium', status: 'To Do', category: 'Study', subjectId: demoSubject.id, createdAt: new Date().toISOString(), demo: true },
        { id: makeId(), title: 'Practice C++ programming', description: 'Sample task — edit or remove it.', dueDate: todayKey(), dueTime: '', priority: 'High', status: 'To Do', category: 'Study', subjectId: codingSubject.id, createdAt: new Date().toISOString(), demo: true }
      );
      state.exams.push({ id: makeId(), title: 'Discrete Structures Quiz', subjectId: demoSubject.id, date: todayKey(), time: '', topics: '', prepStatus: 'Not Started', priority: 'Medium', notes: '', demo: true });
      state.habits.push({ id: makeId(), name: 'Review lessons for 20 minutes', description: 'Sample habit', frequency: 'Daily', weeklyTarget: 3, active: 'Active', startDate: todayKey(), demo: true });
      state.demoMode = true;
    }
    saveState(); render(); toast(state.demoMode ? 'Sample records added. They are labeled demo data.' : 'Sample records removed.');
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'my-peor-data-' + todayKey() + '.json';
    link.click();
    URL.revokeObjectURL(url);
    toast('Data export downloaded.');
  }

  function handleAction(action, target) {
    var id = target.dataset.id;
    var record;
    switch (action) {
      case 'menu': document.querySelector('#sidebar').classList.toggle('mobile-open'); break;
      case 'collapse-sidebar': {
        var sidebar = document.querySelector('#sidebar');
        var collapsed = sidebar.classList.toggle('collapsed');
        document.querySelector('.main-column').classList.toggle('sidebar-collapsed', collapsed);
        target.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        target.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        break;
      }
      case 'theme':
        state.preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        saveState(); render(); break;
      case 'settings': case 'open-settings': setPage('settings'); break;
      case 'add-task': openForm('task'); break;
      case 'add-schedule': openForm('schedule'); break;
      case 'add-subject': openForm('subject'); break;
      case 'add-assessment':
        record = target.dataset.subject ? { subjectId: target.dataset.subject } : null;
        if (!state.subjects.length) { toast('Add a subject before recording an assessment.', true); setPage('subjects'); return; }
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
      case 'edit-subject': record = getRecord('subjects', id); if (record) openForm('subject', record); break;
      case 'edit-assessment': record = getRecord('assessments', id); if (record) openForm('assessment', record); break;
      case 'edit-exam': record = getRecord('exams', id); if (record) openForm('exam', record); break;
      case 'edit-study': record = getRecord('studySessions', id); if (record) openForm('study', record); break;
      case 'edit-habit': record = getRecord('habits', id); if (record) openForm('habit', record); break;
      case 'delete-task': deleteRecord('tasks', id, 'task'); break;
      case 'delete-schedule': deleteRecord('schedule', id, 'schedule block'); break;
      case 'delete-subject': deleteRecord('subjects', id, 'subject'); break;
      case 'delete-assessment': deleteRecord('assessments', id, 'assessment'); break;
      case 'delete-exam': deleteRecord('exams', id, 'exam'); break;
      case 'delete-study': deleteRecord('studySessions', id, 'study session'); break;
      case 'delete-habit': deleteRecord('habits', id, 'habit'); break;
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
      case 'demo': loadDemo(); break;
      case 'export': exportData(); break;
      case 'clear-data':
        if (window.confirm('Permanently clear all My PeOr data stored in this browser?')) {
          state = freshState(); saveState(); render(); toast('Local data cleared.');
        }
        break;
      case 'notifications':
        if (!('Notification' in window)) { toast('Browser notifications are not supported here. In-app reminders remain available.', true); break; }
        if (Notification.permission === 'granted') { state.preferences.notifications = !state.preferences.notifications; saveState(); render(); toast(state.preferences.notifications ? 'Browser notifications enabled.' : 'Browser notifications disabled.'); }
        else if (Notification.permission === 'denied') toast('Notifications are blocked in browser settings. In-app reminders remain available.', true);
        else Notification.requestPermission().then(function (permission) {
          state.preferences.notifications = permission === 'granted';
          saveState(); render();
          toast(permission === 'granted' ? 'Browser notifications enabled.' : 'Notification permission was not granted.');
        });
        break;
    }
  }

  function checkReminders() {
    var now = Date.now();
    state.tasks.forEach(function (task) {
      if (!task.reminderAt || task.status === 'Completed' || state.dismissedReminders.includes(task.id)) return;
      var reminderTime = zonedDateTimeToEpoch(task.reminderAt);
      if (reminderTime <= now && reminderTime >= now - 60000) {
        state.dismissedReminders.push(task.id);
        saveState();
        toast('Reminder: ' + task.title);
        if (state.preferences.notifications && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('My PeOr reminder', { body: task.title });
        }
      }
    });
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

  main.addEventListener('click', function (event) {
    var pageLink = event.target.closest('[data-page-link]');
    if (pageLink) { setPage(pageLink.dataset.pageLink); return; }
    var target = event.target.closest('[data-action]');
    if (target && target.tagName !== 'INPUT') handleAction(target.dataset.action, target);
  });

  main.addEventListener('change', function (event) {
    var target = event.target;
    if (target.matches('[data-action="toggle-task"], [data-action="toggle-habit"]')) {
      handleAction(target.dataset.action, target);
      return;
    }
    if (target.name === 'task-category') { taskCategoryFilter = target.value; render(); }
    if (target.name === 'task-priority') { taskPriorityFilter = target.value; render(); }
    if (target.name === 'task-sort') { taskSort = target.value; render(); }
    if (target.name === 'schedule-date' || target.name === 'calendar-date') {
      selectedDate = target.value || todayKey();
      if (target.name === 'calendar-date') {
        var chosenDate = parseDate(selectedDate);
        calendarDate = new Date(chosenDate.getFullYear(), chosenDate.getMonth(), 1);
      }
      render();
    }
  });

  main.addEventListener('input', function (event) {
    if (event.target.name === 'task-search') {
      var position = event.target.selectionStart;
      taskSearch = event.target.value;
      render();
      var search = main.querySelector('[name="task-search"]');
      search.focus();
      search.setSelectionRange(position, position);
    }
    if (event.target.name === 'range-start') customRange.start = event.target.value;
    if (event.target.name === 'range-end') customRange.end = event.target.value;
  });

  main.addEventListener('submit', function (event) {
    if (event.target.matches('[data-form="settings"]')) {
      event.preventDefault();
      var data = Object.fromEntries(new FormData(event.target).entries());
      if (!data.timezone.trim()) return formError(event.target, 'Timezone is required (for example, Asia/Manila).');
      try {
        new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format(new Date());
      } catch (error) {
        return formError(event.target, 'Enter a valid timezone, such as Asia/Manila.');
      }
      ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes'].forEach(function (key) {
        if (!Number.isInteger(Number(data[key])) || Number(data[key]) < 1 || Number(data[key]) > 180) {
          formError(event.target, 'Pomodoro durations must be whole numbers between 1 and 180 minutes.');
          return;
        }
        data[key] = Number(data[key]);
      });
      if (!Number.isInteger(data.focusMinutes) || !Number.isInteger(data.shortBreakMinutes) || !Number.isInteger(data.longBreakMinutes)) return;
      state.preferences = Object.assign(state.preferences, data);
      if (state.timer.status !== 'running') state.timer.remainingMs = getPhaseMinutes() * 60000;
      saveState(); render(); toast('Preferences saved in this browser.');
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

  function init() {
    loadState();
    selectedDate = todayKey();
    calendarDate = parseDate(selectedDate);
    if (!state.timer.remainingMs || state.timer.status === 'idle') state.timer.remainingMs = getPhaseMinutes() * 60000;
    render();
    if (state.timer.status === 'running') runTimer();
    window.setInterval(checkReminders, 30000);
  }

  init();
}());
