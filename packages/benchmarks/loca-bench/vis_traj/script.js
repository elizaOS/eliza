/**
 * LOCA Trajectory Replayer
 *
 * Interactive visualization for LOCA-bench agent trajectories.
 * Supports playback controls, reasoning block collapsibility,
 * event banners, tool sidebar, and keyboard shortcuts.
 */

class TrajectoryReplayer {
    constructor() {
        // DOM elements
        this.fileSelector = document.getElementById('file-selector');
        this.chatArea = document.getElementById('chat-area');
        this.sidebarContent = document.getElementById('sidebar-content');
        this.progressBar = document.getElementById('progress-bar');
        this.stepCounter = document.getElementById('step-counter');
        this.metricsBadge = document.getElementById('metrics-badge');
        this.metricAccuracy = document.getElementById('metric-accuracy');
        this.metricSteps = document.getElementById('metric-steps');
        this.metricStatus = document.getElementById('metric-status');
        this.btnPlay = document.getElementById('btn-play');
        this.btnPrev = document.getElementById('btn-prev');
        this.btnNext = document.getElementById('btn-next');
        this.btnFirst = document.getElementById('btn-first');
        this.btnLast = document.getElementById('btn-last');

        // State
        this.currentData = null;
        this.displayItems = [];   // Processed items (messages + event banners)
        this.toolResults = {};    // tool_call_id -> tool result content
        this.toolCalls = {};      // tool_call_id -> tool call info
        this.currentStep = -1;
        this.isPlaying = false;
        this.playInterval = null;
        this.playSpeed = 800;     // ms between steps

        this.init();
    }

    async init() {
        await this.loadFileList();
        this.bindEvents();
    }

    // === Data Loading ===

    async loadFileList() {
        try {
            const resp = await fetch('/api/files');
            const files = await resp.json();
            this.populateSelector(files);
        } catch (e) {
            console.error('Failed to load file list:', e);
        }
    }

    populateSelector(files) {
        // Group files by task_name
        const groups = {};
        for (const f of files) {
            const group = f.task_name;
            if (!groups[group]) groups[group] = [];
            groups[group].push(f);
        }

        // Clear and populate
        this.fileSelector.innerHTML = '<option value="">-- Select Trajectory --</option>';

        for (const [groupName, items] of Object.entries(groups)) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = groupName;

            for (const item of items) {
                const opt = document.createElement('option');
                opt.value = item.key;
                const acc = item.accuracy !== null ? `${(item.accuracy * 100).toFixed(0)}%` : '?';
                const status = item.completed ? 'done' : 'incomplete';
                opt.textContent = `${item.state_name} [${acc}, ${status}]`;
                optgroup.appendChild(opt);
            }

            this.fileSelector.appendChild(optgroup);
        }
    }

    async loadTrajectory(key) {
        if (!key) return;

        try {
            const resp = await fetch(`/api/trajectory/${key}`);
            this.currentData = await resp.json();
            this.processTrajectoryData();
            this.resetPlayback();
            this.updateMetrics();
            // Show first step
            this.goToStep(0);
        } catch (e) {
            console.error('Failed to load trajectory:', e);
            this.chatArea.innerHTML = '<div class="empty-state"><p>Failed to load trajectory.</p></div>';
        }
    }

    // === Data Processing ===

    processTrajectoryData() {
        const messages = this.currentData.messages || [];
        const events = this.currentData.events || {};

        this.displayItems = [];
        this.toolResults = {};
        this.toolCalls = {};

        // Build tool results map (tool_call_id -> content)
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                this.toolResults[msg.tool_call_id] = msg.content || '';
            }
        }

        // Build event insertion map: step_index -> [event objects]
        const eventMap = {};
        const eventTypes = [
            { key: 'reset', label: 'Context Reset', cssClass: 'event-reset', icon: '\u{1F6A8}' },
            { key: 'thinking_reset', label: 'Thinking Reset', cssClass: 'event-thinking-reset', icon: '\u{1F9E0}' },
            { key: 'trim', label: 'Context Trimmed', cssClass: 'event-trim', icon: '\u2702\uFE0F' },
            { key: 'summary', label: 'Context Summarized', cssClass: 'event-summary', icon: '\u{1F4CB}' },
        ];

        for (const et of eventTypes) {
            const evList = events[et.key] || [];
            for (const ev of evList) {
                const step = typeof ev === 'object' ? ev.step : ev;
                if (!eventMap[step]) eventMap[step] = [];
                eventMap[step].push({
                    type: 'event',
                    eventType: et.key,
                    label: et.label,
                    cssClass: et.cssClass,
                    icon: et.icon,
                    details: typeof ev === 'object' ? ev : null,
                });
            }
        }

        // Build display items: filter to user/assistant/system, insert events
        let stepIndex = 0;
        for (const msg of messages) {
            if (msg.role === 'tool') continue; // tool messages handled via toolResults

            // Check for events at this step
            if (eventMap[stepIndex]) {
                for (const ev of eventMap[stepIndex]) {
                    this.displayItems.push(ev);
                }
            }

            // Build tool call info for this message
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    this.toolCalls[tc.id] = {
                        id: tc.id,
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                        result: this.toolResults[tc.id] || '',
                    };
                }
            }

            // Extract reasoning: prefer reasoning_content (plain text), then reasoning field,
            // then reasoning_details (may be encrypted)
            let reasoningContent = '';
            let reasoningEncrypted = false;
            if (msg.reasoning_content) {
                reasoningContent = msg.reasoning_content;
            } else if (msg.reasoning && typeof msg.reasoning === 'string') {
                reasoningContent = msg.reasoning;
            } else if (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length > 0) {
                const hasEncrypted = msg.reasoning_details.some(
                    d => d.type === 'reasoning.encrypted'
                );
                if (hasEncrypted) {
                    reasoningEncrypted = true;
                } else {
                    // Concatenate any plain text entries
                    reasoningContent = msg.reasoning_details
                        .filter(d => typeof d === 'string' || (d.type === 'text' && d.text))
                        .map(d => typeof d === 'string' ? d : d.text)
                        .join('\n');
                }
            }

            this.displayItems.push({
                type: 'message',
                role: msg.role,
                content: msg.content || '',
                reasoning_content: reasoningContent,
                reasoning_encrypted: reasoningEncrypted,
                tool_calls: msg.tool_calls || [],
            });

            stepIndex++;
        }

        // Check for events after the last step
        if (eventMap[stepIndex]) {
            for (const ev of eventMap[stepIndex]) {
                this.displayItems.push(ev);
            }
        }
    }

    // === Rendering ===

    renderUpToStep(step) {
        this.chatArea.innerHTML = '';

        for (let i = 0; i <= step && i < this.displayItems.length; i++) {
            const item = this.displayItems[i];
            let el;

            if (item.type === 'event') {
                el = this.createEventBanner(item);
            } else {
                el = this.createMessageElement(item, i);
            }

            this.chatArea.appendChild(el);

            // Trigger animation
            requestAnimationFrame(() => el.classList.add('visible'));
        }

        // Scroll to bottom
        this.chatArea.scrollTop = this.chatArea.scrollHeight;
    }

    createMessageElement(msg, index) {
        const el = document.createElement('div');
        el.className = `message message-${msg.role}`;

        // Role label
        const roleEl = document.createElement('div');
        roleEl.className = 'message-role';
        roleEl.textContent = msg.role === 'assistant' ? 'Assistant' :
                            msg.role === 'user' ? 'User' : 'System';
        el.appendChild(roleEl);

        // Reasoning block (collapsed by default)
        if (msg.reasoning_content) {
            el.appendChild(this.createReasoningBlock(msg.reasoning_content));
        } else if (msg.reasoning_encrypted) {
            el.appendChild(this.createReasoningBlock(null, true));
        }

        // Message content
        if (msg.content) {
            const contentEl = document.createElement('div');
            contentEl.className = 'message-content';
            contentEl.innerHTML = this.renderMarkdown(msg.content);
            el.appendChild(contentEl);
        }

        // Tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            const toolsEl = document.createElement('div');
            toolsEl.className = 'tool-calls-container';

            for (const tc of msg.tool_calls) {
                const chip = document.createElement('div');
                chip.className = 'tool-call-chip';
                chip.onclick = () => this.showToolDetails(tc.id);

                const icon = document.createElement('span');
                icon.className = 'tool-call-icon';
                icon.textContent = this.getToolIcon(tc.function.name);
                chip.appendChild(icon);

                const name = document.createElement('span');
                name.className = 'tool-call-name';
                name.textContent = tc.function.name;
                chip.appendChild(name);

                // Status dot
                const status = document.createElement('span');
                status.className = 'tool-call-status';
                const result = this.toolResults[tc.id];
                if (result !== undefined) {
                    const isError = typeof result === 'string' &&
                        (result.toLowerCase().includes('error') || result.toLowerCase().includes('traceback'));
                    status.classList.add(isError ? 'error' : 'success');
                } else {
                    status.classList.add('pending');
                }
                chip.appendChild(status);

                toolsEl.appendChild(chip);
            }

            el.appendChild(toolsEl);
        }

        return el;
    }

    createReasoningBlock(content, encrypted = false) {
        const block = document.createElement('div');
        block.className = 'reasoning-block';

        // Header
        const header = document.createElement('div');
        header.className = 'reasoning-header';

        if (encrypted) {
            header.innerHTML = `
                <span class="reasoning-icon">\u{1F512}</span>
                <span>Reasoning (encrypted)</span>
            `;
            block.appendChild(header);

            const note = document.createElement('div');
            note.className = 'reasoning-preview';
            note.textContent = 'Reasoning content is encrypted and cannot be displayed.';
            note.style.fontStyle = 'italic';
            block.appendChild(note);
        } else {
            header.innerHTML = `
                <span class="reasoning-icon">\u{1F9E0}</span>
                <span>Thinking</span>
                <span class="reasoning-toggle-icon">\u25BC</span>
            `;
            header.onclick = () => block.classList.toggle('expanded');
            block.appendChild(header);

            // Preview (first ~200 chars)
            const preview = document.createElement('div');
            preview.className = 'reasoning-preview';
            preview.textContent = content.length > 200 ? content.substring(0, 200) + '...' : content;
            block.appendChild(preview);

            // Full content
            const full = document.createElement('div');
            full.className = 'reasoning-full';
            full.textContent = content;
            block.appendChild(full);
        }

        return block;
    }

    createEventBanner(event) {
        const el = document.createElement('div');
        el.className = `event-banner ${event.cssClass}`;

        const icon = document.createElement('span');
        icon.className = 'event-icon';
        icon.textContent = event.icon;
        el.appendChild(icon);

        const label = document.createElement('span');
        label.textContent = event.label;
        el.appendChild(label);

        // Show trim details if available
        if (event.details && event.details.trim_info) {
            const info = event.details.trim_info;
            const detail = document.createElement('span');
            detail.style.fontWeight = 'normal';
            detail.style.fontSize = '12px';
            detail.style.marginLeft = '8px';
            detail.textContent = `(${info.original_message_count}\u2192${info.trimmed_message_count} msgs, ${Math.round(info.original_total_tokens/1000)}k\u2192${Math.round(info.trimmed_total_tokens/1000)}k tokens)`;
            el.appendChild(detail);
        }

        return el;
    }

    // === Tool Sidebar ===

    showToolDetails(toolCallId) {
        const tc = this.toolCalls[toolCallId];
        if (!tc) return;

        // Deselect previous
        document.querySelectorAll('.tool-call-chip.selected').forEach(c => c.classList.remove('selected'));
        // Select clicked chip (find by name match in current DOM)
        document.querySelectorAll('.tool-call-chip').forEach(c => {
            if (c.querySelector('.tool-call-name')?.textContent === tc.name) {
                c.classList.add('selected');
            }
        });

        let html = '';

        // Tool name
        html += `<div class="sidebar-tool-name">${this.getToolIcon(tc.name)} ${tc.name}</div>`;

        // Arguments
        html += '<div class="sidebar-section">';
        html += '<div class="sidebar-section-title">Arguments</div>';
        let args = tc.arguments;
        try {
            args = JSON.stringify(JSON.parse(tc.arguments), null, 2);
        } catch {}
        html += `<div class="sidebar-arguments">${this.escapeHtml(args)}</div>`;
        html += '</div>';

        // Result
        html += '<div class="sidebar-section">';
        html += '<div class="sidebar-section-title">Result</div>';

        const MAX_RESULT_LEN = 500;
        let resultText = tc.result || '(no result)';
        let truncated = false;
        const fullLength = resultText.length;

        if (resultText.length > MAX_RESULT_LEN) {
            truncated = true;
            resultText = resultText.substring(0, MAX_RESULT_LEN);
        }

        html += `<div class="sidebar-result">${this.escapeHtml(resultText)}`;
        if (truncated) {
            html += `</div><div class="truncation-note">... (truncated, full length: ${fullLength.toLocaleString()} chars)</div>`;
        } else {
            html += '</div>';
        }
        html += '</div>';

        this.sidebarContent.innerHTML = html;
    }

    // === Playback Controls ===

    goToStep(step) {
        if (this.displayItems.length === 0) return;

        step = Math.max(0, Math.min(step, this.displayItems.length - 1));
        this.currentStep = step;
        this.renderUpToStep(step);
        this.updateProgressBar();
    }

    nextStep() {
        if (this.currentStep < this.displayItems.length - 1) {
            this.goToStep(this.currentStep + 1);
        } else {
            this.stopPlayback();
        }
    }

    prevStep() {
        if (this.currentStep > 0) {
            this.goToStep(this.currentStep - 1);
        }
    }

    firstStep() {
        this.stopPlayback();
        this.goToStep(0);
    }

    lastStep() {
        this.stopPlayback();
        this.goToStep(this.displayItems.length - 1);
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.stopPlayback();
        } else {
            this.startPlayback();
        }
    }

    startPlayback() {
        if (this.displayItems.length === 0) return;
        if (this.currentStep >= this.displayItems.length - 1) {
            this.goToStep(0);
        }

        this.isPlaying = true;
        this.btnPlay.textContent = '\u23F8';
        this.playInterval = setInterval(() => this.nextStep(), this.playSpeed);
    }

    stopPlayback() {
        this.isPlaying = false;
        this.btnPlay.textContent = '\u25B6';
        if (this.playInterval) {
            clearInterval(this.playInterval);
            this.playInterval = null;
        }
    }

    resetPlayback() {
        this.stopPlayback();
        this.currentStep = -1;
        this.chatArea.innerHTML = '';
        this.sidebarContent.innerHTML = '<p class="sidebar-empty">Click a tool call to view details.</p>';
        this.progressBar.max = Math.max(0, this.displayItems.length - 1);
        this.progressBar.value = 0;
        this.updateProgressBar();
    }

    updateProgressBar() {
        this.progressBar.value = this.currentStep;
        this.stepCounter.textContent = `${this.currentStep + 1} / ${this.displayItems.length}`;
    }

    updateMetrics() {
        if (!this.currentData || !this.currentData.metrics) {
            this.metricsBadge.style.display = 'none';
            return;
        }

        const m = this.currentData.metrics;
        this.metricsBadge.style.display = 'flex';

        // Accuracy
        if (m.accuracy !== null && m.accuracy !== undefined) {
            const pct = (m.accuracy * 100).toFixed(0);
            this.metricAccuracy.textContent = `Accuracy: ${pct}%`;
            this.metricAccuracy.className = 'metric';
            if (m.accuracy >= 0.8) this.metricAccuracy.classList.add('metric-accuracy-high');
            else if (m.accuracy >= 0.4) this.metricAccuracy.classList.add('metric-accuracy-mid');
            else this.metricAccuracy.classList.add('metric-accuracy-low');
        }

        // Steps
        if (m.total_steps !== null && m.total_steps !== undefined) {
            this.metricSteps.textContent = `Steps: ${m.total_steps}`;
            this.metricSteps.className = 'metric metric-steps';
        }

        // Completed
        this.metricStatus.textContent = m.completed ? 'Completed' : 'Incomplete';
        this.metricStatus.className = 'metric ' + (m.completed ? 'metric-completed' : 'metric-incomplete');
    }

    // === Event Binding ===

    bindEvents() {
        this.fileSelector.addEventListener('change', () => {
            const key = this.fileSelector.value;
            if (key) this.loadTrajectory(key);
        });

        this.btnPlay.addEventListener('click', () => this.togglePlayback());
        this.btnPrev.addEventListener('click', () => { this.stopPlayback(); this.prevStep(); });
        this.btnNext.addEventListener('click', () => { this.stopPlayback(); this.nextStep(); });
        this.btnFirst.addEventListener('click', () => this.firstStep());
        this.btnLast.addEventListener('click', () => this.lastStep());

        this.progressBar.addEventListener('input', () => {
            this.stopPlayback();
            this.goToStep(parseInt(this.progressBar.value));
        });

        document.addEventListener('keydown', (e) => {
            // Don't capture when typing in input/select
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    this.togglePlayback();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    this.stopPlayback();
                    this.prevStep();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    this.stopPlayback();
                    this.nextStep();
                    break;
                case 'Home':
                    e.preventDefault();
                    this.firstStep();
                    break;
                case 'End':
                    e.preventDefault();
                    this.lastStep();
                    break;
            }
        });
    }

    // === Utilities ===

    getToolIcon(toolName) {
        if (!toolName) return '\u{1F527}';
        const name = toolName.toLowerCase();

        if (name.includes('filesystem') || name.includes('file_system'))  return '\u{1F4C1}';
        if (name.includes('excel') || name.includes('spreadsheet'))       return '\u{1F4CA}';
        if (name.includes('canvas'))                                      return '\u{1F393}';
        if (name.includes('google_cloud') || name.includes('bigquery'))   return '\u2601\uFE0F';
        if (name.includes('snowflake'))                                   return '\u2744\uFE0F';
        if (name.includes('google_sheet'))                                return '\u{1F4D7}';
        if (name.includes('woocommerce') || name.includes('shop'))        return '\u{1F6D2}';
        if (name.includes('email') || name.includes('mail'))              return '\u{1F4E7}';
        if (name.includes('yfinance') || name.includes('yahoo'))          return '\u{1F4C8}';
        if (name.includes('python') || name.includes('execute'))          return '\u{1F40D}';
        if (name.includes('memory'))                                      return '\u{1F4DD}';
        if (name.includes('claim_done') || name.includes('submit'))       return '\u2705';
        if (name.includes('search') || name.includes('find'))             return '\u{1F50D}';
        if (name.includes('read') || name.includes('get'))                return '\u{1F4D6}';
        if (name.includes('write') || name.includes('create') || name.includes('update')) return '\u270F\uFE0F';
        if (name.includes('delete') || name.includes('remove'))           return '\u{1F5D1}\uFE0F';
        if (name.includes('list'))                                        return '\u{1F4CB}';

        return '\u{1F527}';
    }

    renderMarkdown(text) {
        if (!text) return '';
        try {
            if (typeof marked !== 'undefined') {
                return marked.parse(text);
            }
        } catch {}
        return this.escapeHtml(text).replace(/\n/g, '<br>');
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.replayer = new TrajectoryReplayer();
});
