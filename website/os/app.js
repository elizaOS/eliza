'use strict';

(function () {
  var desktop = document.getElementById('desktop');
  var menu = document.getElementById('start-menu');
  var startButton = document.getElementById('start-button');
  var taskbarApps = document.getElementById('taskbar-apps');
  var clock = document.getElementById('clock');
  var announcement = document.getElementById('desktop-announcement');
  var windows = Array.prototype.slice.call(document.querySelectorAll('[data-window]'));
  var topZ = 10;
  var healthTimer = 0;

  function getWindow(name) {
    return windows.find(function (node) { return node.dataset.window === name; });
  }

  function announce(message) {
    if (announcement) announcement.textContent = message;
  }

  function setMenu(open) {
    menu.hidden = !open;
    startButton.setAttribute('aria-expanded', String(open));
  }

  function focusWindow(node) {
    topZ += 1;
    node.style.zIndex = String(topZ);
    windows.forEach(function (item) {
      var button = taskbarApps.querySelector('[data-task="' + item.dataset.window + '"]');
      if (button) button.setAttribute('aria-pressed', String(item === node && !item.hidden));
    });
  }

  function updateTaskbar() {
    taskbarApps.replaceChildren();
    windows.forEach(function (node) {
      if (node.hidden && node.dataset.minimized !== 'true') return;
      var title = node.querySelector('.title-bar h2').textContent;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'taskbar-app';
      button.dataset.task = node.dataset.window;
      button.textContent = title;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        if (node.dataset.minimized === 'true') {
          node.hidden = false;
          node.dataset.minimized = 'false';
        } else if (node.style.zIndex === String(topZ)) {
          node.dataset.minimized = 'true';
          node.hidden = true;
        }
        updateTaskbar();
        if (!node.hidden) focusWindow(node);
      });
      taskbarApps.appendChild(button);
    });
  }

  function openWindow(name) {
    var node = getWindow(name);
    if (!node) return;
    node.hidden = false;
    node.dataset.minimized = 'false';
    updateTaskbar();
    focusWindow(node);
    setMenu(false);
    announce(node.querySelector('.title-bar h2').textContent + ' opened.');
    if (name === 'status') checkHealth();
  }

  function closeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'false';
    updateTaskbar();
    announce(node.querySelector('.title-bar h2').textContent + ' closed.');
  }

  function minimizeWindow(node) {
    node.hidden = true;
    node.dataset.minimized = 'true';
    updateTaskbar();
    announce(node.querySelector('.title-bar h2').textContent + ' minimized.');
  }

  function setHealth(text, state) {
    var output = document.getElementById('backend-status');
    var light = document.querySelector('.status-light');
    output.textContent = text;
    output.dataset.state = state;
    light.style.background = state === 'ok' ? '#008000' : state === 'error' ? '#c00000' : '#f0c000';
  }

  async function checkHealth() {
    var output = document.getElementById('backend-status');
    if (output.textContent === 'Checking…') setHealth('Checking…', 'loading');
    var checkedAt = document.getElementById('checked-at');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 6000);
    try {
      var response = await fetch('/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json();
      if (!result || typeof result.status !== 'string') throw new Error('Unexpected health response');
      setHealth(result.status + (result.engine ? ' · ' + result.engine : ''), 'ok');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } catch (error) {
      setHealth('Unavailable · ' + (error.name === 'AbortError' ? 'timed out' : 'probe failed'), 'error');
      checkedAt.textContent = new Date().toLocaleTimeString();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function startDrag(event) {
    var handle = event.target.closest('[data-drag-handle]');
    var node = handle && handle.closest('[data-window]');
    if (!handle || !node || event.target.closest('button') || event.button !== 0) return;
    event.preventDefault();
    focusWindow(node);
    var startX = event.clientX;
    var startY = event.clientY;
    var rect = node.getBoundingClientRect();
    var moved = false;
    handle.setPointerCapture(event.pointerId);
    function move(moveEvent) {
      var dx = moveEvent.clientX - startX;
      var dy = moveEvent.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      var x = Math.max(0, Math.min(window.innerWidth - Math.min(120, rect.width), rect.left + dx));
      var y = Math.max(0, Math.min(window.innerHeight - 60, rect.top + dy));
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      node.style.right = 'auto';
      node.style.bottom = 'auto';
    }
    function finish() {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (moved) event.stopPropagation();
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  desktop.addEventListener('click', function (event) {
    var launcher = event.target.closest('[data-open]');
    if (launcher) {
      openWindow(launcher.dataset.open);
      return;
    }
    var action = event.target.closest('[data-action]');
    if (action) {
      var node = action.closest('[data-window]');
      if (action.dataset.action === 'close') closeWindow(node);
      if (action.dataset.action === 'minimize') minimizeWindow(node);
      return;
    }
    if (event.target.closest('[data-refresh]')) checkHealth();
    if (event.target.closest('[data-window]')) focusWindow(event.target.closest('[data-window]'));
  });
  desktop.addEventListener('pointerdown', startDrag);

  startButton.addEventListener('click', function () {
    setMenu(menu.hidden);
  });
  document.addEventListener('click', function (event) {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== startButton && !startButton.contains(event.target)) {
      setMenu(false);
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      startButton.focus();
    }
  });
  document.getElementById('browser-page').addEventListener('change', function (event) {
    if (event.target.value !== '/' && event.target.value !== '/status/') return;
    var page = event.target.value === '/status/' ? '/status/' : '/';
    var iframe = document.querySelector('#window-browser iframe');
    iframe.src = page;
    document.querySelector('#window-browser .address-row a').href = page;
  });

  function updateClock() {
    var now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  updateClock();
  window.setInterval(updateClock, 30_000);
  updateTaskbar();
  var initiallyOpen = windows.find(function (node) { return !node.hidden; });
  if (initiallyOpen) focusWindow(initiallyOpen);
  checkHealth();
  healthTimer = window.setInterval(function () {
    if (!getWindow('status').hidden) checkHealth();
  }, 30_000);
  window.addEventListener('pagehide', function () {
    window.clearInterval(healthTimer);
  }, { once: true });
})();