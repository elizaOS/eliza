document.addEventListener('DOMContentLoaded', () => {
    fetchAvailableConfigs().then(() => {
        fetchConfig();
        fetchTasks();
    });
    // Bind filter functionality
    document.getElementById('total-tasks').parentElement.addEventListener('click', () => setTaskFilter('all'));
    document.getElementById('active-tasks').parentElement.addEventListener('click', () => setTaskFilter('active'));
    document.getElementById('completed-tasks').parentElement.addEventListener('click', () => setTaskFilter('completed'));
    document.getElementById('error-tasks').parentElement.addEventListener('click', () => setTaskFilter('error'));
});

let allTaskData = null;
let currentFilter = 'all';
let availableConfigs = [];
let currentConfig = null;
let categoryStats = {};

// Get configuration from URL parameters
function getConfigFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    return {
        action_space: urlParams.get('action_space'),
        observation_type: urlParams.get('observation_type'),
        model_name: urlParams.get('model_name')
    };
}

// Update URL parameters with current configuration
function updateURLWithConfig(config) {
    const url = new URL(window.location);
    if (config.action_space) url.searchParams.set('action_space', config.action_space);
    else url.searchParams.delete('action_space');
    if (config.observation_type) url.searchParams.set('observation_type', config.observation_type);
    else url.searchParams.delete('observation_type');
    if (config.model_name) url.searchParams.set('model_name', config.model_name);
    else url.searchParams.delete('model_name');
    
    window.history.replaceState({}, '', url);
}

// Build API URL with config parameters
function buildAPIURL(endpoint, config = null) {
    const params = new URLSearchParams();
    const configToUse = config || getConfigFromURL();
    
    if (configToUse.action_space) params.set('action_space', configToUse.action_space);
    if (configToUse.observation_type) params.set('observation_type', configToUse.observation_type);
    if (configToUse.model_name) params.set('model_name', configToUse.model_name);
    
    return params.toString() ? `${endpoint}?${params.toString()}` : endpoint;
}

function refreshPage() {
    // Save expanded state before refresh
    const expandedTaskTypes = [];
    document.querySelectorAll('.task-type').forEach(section => {
        if (!section.classList.contains('collapsed')) {
            const typeName = section.querySelector('.task-type-name').textContent.trim();
            expandedTaskTypes.push(typeName);
        }
    });
    
    // Store in sessionStorage
    sessionStorage.setItem('expandedTaskTypes', JSON.stringify(expandedTaskTypes));
    
    // Full page refresh
    window.location.reload();
}

function fetchTasks() {
    fetch(buildAPIURL('/api/tasks/brief'))
        .then(response => response.json())
        .then(data => {
            allTaskData = data;
            categoryStats = calculateCategoryStats(data);
            renderTasks(data);
            updateStatistics(data);
        })
        .catch(error => console.error('Error fetching tasks:', error));
}

function setTaskFilter(filter) {
    currentFilter = filter;
    if (!allTaskData) return;
    renderTasks(allTaskData);
    // Highlight selected card
    document.querySelectorAll('.stat-card').forEach(card => card.classList.remove('selected'));
    if (filter === 'all') {
        document.getElementById('total-tasks').parentElement.classList.add('selected');
    } else if (filter === 'active') {
        document.getElementById('active-tasks').parentElement.classList.add('selected');
    } else if (filter === 'completed') {
        document.getElementById('completed-tasks').parentElement.classList.add('selected');
    } else if (filter === 'error') {
        document.getElementById('error-tasks').parentElement.classList.add('selected');
    }
}

// Update statistics info
function updateStatistics(data) {
    let totalTasks = 0;
    let activeTasks = 0;
    let completedTasks = 0;
    let errorTasks = 0;
    let totalScore = 0;
    
    Object.entries(data).forEach(([taskType, tasks]) => {
        totalTasks += tasks.length;
        tasks.forEach(task => {
            if (task.status.status === 'Running' || task.status.status === 'Preparing' || task.status.status === 'Initializing') {
                activeTasks++;
            } else if (task.status.status === 'Done' || task.status.status === 'Done (Message Exit)' || task.status.status === 'Done (Max Steps)' || task.status.status === 'Done (Thought Exit)') {
                completedTasks++;
                // Calculate score if task is completed
                if (task.status.result) {
                    try {
                        const score = parseFloat(task.status.result);
                        if (!isNaN(score) && score >= 0 && score <= 1) {
                            totalScore += score;
                        }
                    } catch (e) {
                        console.log(`Could not parse score for task: ${task.id}`);
                    }
                }
            } else if (task.status.status === 'Error') {
                errorTasks++;
            }
        });
    });
    
    document.getElementById('total-tasks').textContent = totalTasks;
    document.getElementById('active-tasks').textContent = activeTasks;
    document.getElementById('completed-tasks').textContent = completedTasks;
    document.getElementById('error-tasks').textContent = errorTasks;
    
    // Update score display with formatted score and accuracy percentage
    const scoreDisplay = document.getElementById('score-display');
    if (completedTasks > 0) {
        const scoreFormatted = totalScore.toFixed(2);
        const averageScore = totalScore / completedTasks;
        const accuracyPercentage = (averageScore * 100).toFixed(1);
        scoreDisplay.innerHTML = `<span>${scoreFormatted}</span> / <span>${completedTasks}</span> <span class="accuracy-percentage">(${accuracyPercentage}%)</span>`;
    } else {
        scoreDisplay.innerHTML = '<span>0.00</span> / <span>0</span> <span class="accuracy-percentage">(0.0%)</span>';
    }
    
    // Highlight the currently selected statistics card
    document.querySelectorAll('.stat-card').forEach(card => card.classList.remove('selected'));
    if (currentFilter === 'all') {
        document.getElementById('total-tasks').parentElement.classList.add('selected');
    } else if (currentFilter === 'active') {
        document.getElementById('active-tasks').parentElement.classList.add('selected');
    } else if (currentFilter === 'completed') {
        document.getElementById('completed-tasks').parentElement.classList.add('selected');
    } else if (currentFilter === 'error') {
        document.getElementById('error-tasks').parentElement.classList.add('selected');
    }
}

function renderTasks(data) {
    const container = document.getElementById('task-container');
    container.innerHTML = '';
    let filteredData = {};
    if (currentFilter === 'all') {
        filteredData = data;
    } else {
        Object.entries(data).forEach(([taskType, tasks]) => {
            let filteredTasks = [];
            if (currentFilter === 'active') {
                filteredTasks = tasks.filter(task => ['Running', 'Preparing', 'Initializing'].includes(task.status.status));
            } else if (currentFilter === 'completed') {
                filteredTasks = tasks.filter(task => task.status.status === 'Done' || task.status.status === 'Done (Message Exit)' || task.status.status === 'Done (Max Steps)'|| task.status.status === 'Done (Thought Exit)');
            } else if (currentFilter === 'error') {
                filteredTasks = tasks.filter(task => task.status.status === 'Error');
            }
            if (filteredTasks.length > 0) {
                filteredData[taskType] = filteredTasks;
            }
        });
    }
    if (Object.keys(filteredData).length === 0) {
        container.innerHTML = '<div class="no-tasks"><i class="fas fa-info-circle"></i> No tasks at the moment</div>';
        return;
    }
    
    Object.entries(filteredData).forEach(([taskType, tasks]) => {
        // Calculate task statistics for this type
        let runningCount = 0;
        let completedCount = 0;
        let errorCount = 0;
        
        tasks.forEach(task => {
            if (task.status.status === 'Running' || task.status.status === 'Preparing' || task.status.status === 'Initializing') {
                runningCount++;
            } else if (task.status.status === 'Done' || task.status.status === 'Done (Message Exit)' || task.status.status === 'Done (Max Steps)' || task.status.status === 'Done (Thought Exit)') {
                completedCount++;
            } else if (task.status.status === 'Error') {
                errorCount++;
            }
        });
        
        // Create the task type card
        const typeSection = document.createElement('div');
        typeSection.className = 'task-type';
        
        // Create header with task type name and statistics
        const typeHeader = document.createElement('div');
        typeHeader.className = 'task-type-header';
        
        // Get category stats for this task type
        const stats = categoryStats[taskType] || {};
        
        typeHeader.innerHTML = `
            <span class="task-type-name"><i class="fas fa-layer-group"></i> ${taskType}</span>
            <div class="task-type-stats">
                ${errorCount > 0 ? `<span class="task-stat error"><i class="fas fa-exclamation-circle"></i> ${errorCount} error</span>` : ''}
                <span class="task-stat"><i class="fas fa-tasks"></i> ${tasks.length} total</span>
                <span class="task-stat running"><i class="fas fa-running"></i> ${runningCount} active</span>
                <span class="task-stat completed"><i class="fas fa-check-circle"></i> ${completedCount} completed</span>
                ${stats.total_score ? `<span class="task-stat score"><i class="fas fa-star"></i> ${stats.total_score} total score</span>` : ''}
                ${stats.avg_steps ? `<span class="task-stat steps"><i class="fas fa-chart-line"></i> ${stats.avg_steps} avg steps</span>` : ''}
            </div>
        `;
        typeSection.appendChild(typeHeader);
        
        // Create container for task cards
        const tasksContainer = document.createElement('div');
        tasksContainer.className = 'tasks-container';
        
        // Set default collapsed state
        typeSection.classList.add('collapsed');
        tasksContainer.setAttribute('aria-hidden', 'true');
        
        if (tasks.length === 0) {
            const noTasks = document.createElement('div');
            noTasks.className = 'no-tasks';
            noTasks.innerHTML = '<i class="fas fa-info-circle"></i> No Tasks Available';
            tasksContainer.appendChild(noTasks);
        } else {
            // Add scrolling for large task lists
            if (tasks.length > 10) {
                tasksContainer.style.maxHeight = '600px';
                tasksContainer.style.overflowY = 'auto';
            }
            
            tasks.forEach(task => {
                const taskCard = document.createElement('div');
                taskCard.className = 'task-card';
                // Add data attributes for later updates
                taskCard.setAttribute('data-task-id', task.id);
                taskCard.setAttribute('data-task-type', taskType);
                
                const taskHeader = document.createElement('div');
                taskHeader.className = 'task-header';
                
                const taskTitle = document.createElement('div');
                taskTitle.className = 'task-title';
                taskTitle.innerHTML = `<i class="fas fa-tasks"></i> Task ID: ${task.id}`;
                taskHeader.appendChild(taskTitle);
                
                const taskStatus = document.createElement('div');
                taskStatus.className = 'task-status';
                let statusClass = '';
                let statusIcon = '';
                
                switch(task.status.status) {
                    case 'Not Started':
                        statusClass = 'status-not-started';
                        statusIcon = 'fa-hourglass-start';
                        break;
                    case 'Preparing':
                    case 'Initializing':
                        statusClass = 'status-preparing';
                        statusIcon = 'fa-spinner fa-pulse';
                        break;
                    case 'Running':
                        statusClass = 'status-running';
                        statusIcon = 'fa-running';
                        break;
                    case 'Done':
                    case 'Done (Message Exit)':
                    case 'Done (Max Steps)':
                    case 'Done (Thought Exit)':
                        statusClass = 'status-completed';
                        statusIcon = 'fa-check-circle';
                        break;
                    case 'Error':
                        statusClass = 'status-error';
                        statusIcon = 'fa-exclamation-circle';
                        break;
                    default:
                        statusClass = 'status-unknown';
                        statusIcon = 'fa-question-circle';
                        break;
                }
                
                taskStatus.classList.add(statusClass);
                taskStatus.innerHTML = `<i class="fas ${statusIcon}"></i> ${task.status.status}`;
                taskHeader.appendChild(taskStatus);
                taskCard.appendChild(taskHeader);
                
                const taskInstruction = document.createElement('div');
                taskInstruction.className = 'task-instruction';
                taskInstruction.innerHTML = `<strong><i class="fas fa-info-circle"></i> Instruction:</strong> ${task.instruction}`;
                taskCard.appendChild(taskInstruction);
                
                const taskProgress = document.createElement('div');
                taskProgress.className = 'task-details';
                
                if (task.status.progress > 0) {
                    const progressText = document.createElement('div');
                    progressText.innerHTML = `<i class="fas fa-chart-line"></i> Progress: ${task.status.progress}/${task.status.max_steps} step(s)`;
                    taskProgress.appendChild(progressText);
                    
                    const progressBar = document.createElement('div');
                    progressBar.className = 'progress-bar';
                    const progressFill = document.createElement('div');
                    progressFill.className = 'progress-fill';
                    const percentage = (task.status.progress / task.status.max_steps) * 100;
                    progressFill.style.width = `${percentage}%`;
                    progressBar.appendChild(progressFill);
                    taskProgress.appendChild(progressBar);
                    
                    const progressPercentage = document.createElement('div');
                    progressPercentage.className = 'progress-percentage';
                    progressPercentage.textContent = `${Math.round(percentage)}%`;
                    taskProgress.appendChild(progressPercentage);
                }
                
                if (task.status.last_update) {
                    const timestamp = document.createElement('div');
                    timestamp.className = 'timestamp';
                    timestamp.innerHTML = `<i class="far fa-clock"></i> Last Update: ${task.status.last_update}`;
                    taskProgress.appendChild(timestamp);
                }
                
                if (task.status.result) {
                    const resultDiv = document.createElement('div');
                    resultDiv.className = 'task-result';
                    resultDiv.innerHTML = `<strong><i class="fas fa-flag-checkered"></i> Result:</strong> ${task.status.result}`;
                    taskProgress.appendChild(resultDiv);
                }
                
                taskCard.appendChild(taskProgress);
                
                if (task.status.status !== 'Not Started') {
                    taskCard.style.cursor = 'pointer';
                    taskCard.addEventListener('click', () => {
                        const config = getConfigFromURL();
                        const params = new URLSearchParams();
                        if (config.action_space) params.set('action_space', config.action_space);
                        if (config.observation_type) params.set('observation_type', config.observation_type);
                        if (config.model_name) params.set('model_name', config.model_name);
                        
                        const url = params.toString() ? 
                            `/task/${taskType}/${task.id}?${params.toString()}` : 
                            `/task/${taskType}/${task.id}`;
                        window.location.href = url;
                    });
                }
                tasksContainer.appendChild(taskCard);
            });
        }
        typeSection.appendChild(tasksContainer);
        
        // Toggle collapse when clicking on the header
        typeHeader.addEventListener('click', (event) => {
            // Prevent toggling when clicking task cards
            if (!event.target.closest('.task-card')) {
                typeSection.classList.toggle('collapsed');
                
                // Set appropriate aria attributes for accessibility
                const isCollapsed = typeSection.classList.contains('collapsed');
                tasksContainer.setAttribute('aria-hidden', isCollapsed);
                
                // Update session storage with current expanded state
                const expandedTaskTypes = [];
                document.querySelectorAll('.task-type').forEach(section => {
                    if (!section.classList.contains('collapsed')) {
                        const typeName = section.querySelector('.task-type-name').textContent.trim();
                        expandedTaskTypes.push(typeName);
                    }
                });
                sessionStorage.setItem('expandedTaskTypes', JSON.stringify(expandedTaskTypes));
            }
        });
        
        // Check if this task type was expanded before refresh
        const expandedTaskTypes = JSON.parse(sessionStorage.getItem('expandedTaskTypes') || '[]');
        if (expandedTaskTypes.includes(taskType)) {
            typeSection.classList.remove('collapsed');
            tasksContainer.setAttribute('aria-hidden', 'false');
        }
        
        container.appendChild(typeSection);
    });
}

function fetchAvailableConfigs() {
    return fetch('/api/available-configs')
        .then(response => response.json())
        .then(data => {
            availableConfigs = data;
            populateConfigSelect();
            return data;
        })
        .catch(error => {
            console.error('Error fetching available configs:', error);
            return [];
        });
}

function populateConfigSelect() {
    const select = document.getElementById('config-select');
    select.innerHTML = '';
    
    if (availableConfigs.length === 0) {
        select.innerHTML = '<option value="">No configurations found in results directory</option>';
        return;
    }
    
    // Add available configurations
    availableConfigs.forEach((config, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${config.action_space} / ${config.observation_type} / ${config.model_name}`;
        select.appendChild(option);
    });
}

function changeConfiguration() {
    const select = document.getElementById('config-select');
    const selectedIndex = select.value;
    
    if (selectedIndex === '' || selectedIndex < 0 || selectedIndex >= availableConfigs.length) {
        return;
    }
    
    const selectedConfig = availableConfigs[selectedIndex];
    
    // Update URL parameters and do full page refresh
    updateURLWithConfig(selectedConfig);
    window.location.reload();
}

function fetchConfig() {
    // Check URL parameters first
    const urlConfig = getConfigFromURL();
    
    if (urlConfig.action_space && urlConfig.observation_type && urlConfig.model_name) {
        // Use config from URL and fetch detailed info
        const params = new URLSearchParams();
        params.set('action_space', urlConfig.action_space);
        params.set('observation_type', urlConfig.observation_type);
        params.set('model_name', urlConfig.model_name);
        
        return fetch(`/api/current-config?${params.toString()}`)
            .then(response => response.json())
            .then(data => {
                currentConfig = data;
                displayConfig(data);
                updateConfigSelect();
                return data;
            })
            .catch(error => {
                console.error('Error fetching config:', error);
                displayConfigError();
            });
    } else {
        // Fallback to default config from server
        return fetch('/api/current-config')
            .then(response => response.json())
            .then(data => {
                currentConfig = data;
                displayConfig(data);
                updateConfigSelect();
                // Update URL with current config
                updateURLWithConfig(data);
                return data;
            })
            .catch(error => {
                console.error('Error fetching config:', error);
                displayConfigError();
            });
    }
}

function updateConfigSelect() {
    if (!currentConfig || availableConfigs.length === 0) return;
    
    const select = document.getElementById('config-select');
    const currentConfigIndex = availableConfigs.findIndex(config => 
        config.action_space === currentConfig.action_space &&
        config.observation_type === currentConfig.observation_type &&
        config.model_name === currentConfig.model_name
    );
    
    if (currentConfigIndex !== -1) {
        select.value = currentConfigIndex;
    } else {
        // Current config not found in available configs, select the first one if available
        if (availableConfigs.length > 0) {
            select.value = 0;
            console.warn('Current config not found in available configs, defaulting to first available config');
        }
    }
}

function displayConfig(config) {
    document.getElementById('action-space').textContent = config.action_space || 'N/A';
    document.getElementById('observation-type').textContent = config.observation_type || 'N/A';
    document.getElementById('model-name').textContent = config.model_name || 'N/A';
    document.getElementById('max-steps').textContent = config.max_steps || 'N/A';
    
    // Display additional model args from args.json (excluding main config params)
    const modelArgsElement = document.getElementById('model-args');
    if (config.model_args && Object.keys(config.model_args).length > 0) {
        // Skip the main config parameters that are already displayed
        const skipKeys = ['action_space', 'observation_type', 'model_name', 'max_steps'];
        const additionalArgs = Object.entries(config.model_args).filter(([key]) => !skipKeys.includes(key));
        
        if (additionalArgs.length > 0) {
            let argsHtml = `
                <div class="config-collapsible">
                    <div class="config-collapsible-header" onclick="toggleConfigArgs()">
                        <i class="fas fa-chevron-right" id="config-args-chevron"></i>
                        <span>Additional Parameters (${additionalArgs.length})</span>
                    </div>
                    <div class="config-collapsible-content" id="config-args-content">`;
            
            additionalArgs.forEach(([key, value]) => {
                argsHtml += `
                    <div class="config-item">
                        <span class="config-label">${key}:</span>
                        <span class="config-value">${JSON.stringify(value)}</span>
                    </div>`;
            });
            
            argsHtml += `
                    </div>
                </div>`;
            
            modelArgsElement.innerHTML = argsHtml;
            modelArgsElement.style.display = 'block';
        } else {
            modelArgsElement.style.display = 'none';
        }
    } else {
        modelArgsElement.style.display = 'none';
    }
}

function displayConfigError() {
    const configValues = document.querySelectorAll('.config-value');
    configValues.forEach(element => {
        element.textContent = 'Error loading';
        element.style.color = '#dc3545';
    });
}

function calculateCategoryStats(data) {
    const stats = {};
    
    Object.entries(data).forEach(([taskType, tasks]) => {
        let totalTasks = tasks.length;
        let completedTasks = 0;
        let runningTasks = 0;
        let errorTasks = 0;
        let totalScore = 0;
        let totalSteps = 0;
        let completedWithSteps = 0;
        
        tasks.forEach(task => {
            const status = task.status.status;
            
            if (['Done', 'Done (Message Exit)', 'Done (Max Steps)', 'Done (Thought Exit)'].includes(status)) {
                completedTasks++;
                
                // Calculate score if available
                if (task.status.result) {
                    try {
                        const score = parseFloat(task.status.result);
                        if (!isNaN(score) && score >= 0 && score <= 1) {
                            totalScore += score;
                        }
                    } catch (e) {
                        // Ignore parsing errors
                    }
                }
                
                // Calculate steps for completed tasks
                if (task.status.progress && task.status.progress > 0) {
                    totalSteps += task.status.progress;
                    completedWithSteps++;
                }
                
            } else if (['Running', 'Preparing', 'Initializing'].includes(status)) {
                runningTasks++;
                
            } else if (status === 'Error') {
                errorTasks++;
            }
        });
        
        // Calculate averages
        const avgScore = completedTasks > 0 ? totalScore / completedTasks : 0;
        const avgSteps = completedWithSteps > 0 ? totalSteps / completedWithSteps : 0;
        const completionRate = totalTasks > 0 ? (completedTasks / totalTasks * 100) : 0;
        
        stats[taskType] = {
            total_tasks: totalTasks,
            completed_tasks: completedTasks,
            running_tasks: runningTasks,
            error_tasks: errorTasks,
            total_score: Math.round(totalScore * 100) / 100,
            avg_score: Math.round(avgScore * 10000) / 10000,
            avg_steps: Math.round(avgSteps * 10) / 10,
            completion_rate: Math.round(completionRate * 10) / 10
        };
    });
    
    return stats;
}

function toggleConfigArgs() {
    const content = document.getElementById('config-args-content');
    const chevron = document.getElementById('config-args-chevron');
    
    if (content.style.display === 'none' || !content.style.display) {
        content.style.display = 'block';
        chevron.classList.remove('fa-chevron-right');
        chevron.classList.add('fa-chevron-down');
    } else {
        content.style.display = 'none';
        chevron.classList.remove('fa-chevron-down');
        chevron.classList.add('fa-chevron-right');
    }
}

function clearCacheAndRefresh() {
    if (!confirm('Clearing the cache will cause slower loading temporarily as data needs to be reloaded. Continue?')) {
        return;
    }
    
    const button = document.getElementById('clear-cache-btn');
    const originalText = button.innerHTML;
    
    // Show loading state
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Clearing...';
    button.disabled = true;
    
    // Build URL with current configuration parameters
    const clearCacheUrl = buildAPIURL('/api/clear-cache');
    
    fetch(clearCacheUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        }
    })
    .then(response => response.json())
    .then(data => {
        console.log('Cache cleared:', data.message);
        // Refresh the page after clearing cache
        window.location.reload();
    })
    .catch(error => {
        console.error('Error clearing cache:', error);
        alert('Failed to clear cache. Please try again.');
        
        // Restore button state
        button.innerHTML = originalText;
        button.disabled = false;
    });
}
