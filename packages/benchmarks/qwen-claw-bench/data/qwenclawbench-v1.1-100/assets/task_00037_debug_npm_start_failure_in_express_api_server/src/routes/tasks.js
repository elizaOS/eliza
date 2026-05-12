const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// In-memory store
let tasks = [
  {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    title: 'Set up CI/CD pipeline',
    description: 'Configure GitHub Actions for automated testing and deployment',
    status: 'in_progress',
    priority: 'high',
    assignee: 'alice@taskflow.io',
    createdAt: '2026-02-08T10:00:00Z',
    updatedAt: '2026-02-09T14:30:00Z'
  },
  {
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    title: 'Write API documentation',
    description: 'Document all REST endpoints with request/response examples',
    status: 'todo',
    priority: 'medium',
    assignee: 'bob@taskflow.io',
    createdAt: '2026-02-09T08:00:00Z',
    updatedAt: '2026-02-09T08:00:00Z'
  }
];

// GET all tasks
router.get('/', (req, res) => {
  const { status, priority } = req.query;
  let filtered = [...tasks];

  if (status) {
    filtered = filtered.filter(t => t.status === status);
  }
  if (priority) {
    filtered = filtered.filter(t => t.priority === priority);
  }

  logger.info(`Fetched ${filtered.length} tasks`);
  res.json({ count: filtered.length, tasks: filtered });
});

// GET task by ID
router.get('/:id', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// POST create task
router.post('/', (req, res) => {
  const { title, description, priority, assignee } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const task = {
    id: uuidv4(),
    title,
    description: description || '',
    status: 'todo',
    priority: priority || 'medium',
    assignee: assignee || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  tasks.push(task);
  logger.info(`Created task: ${task.id}`);
  res.status(201).json(task);
});

// PUT update task
router.put('/:id', (req, res) => {
  const index = tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }

  tasks[index] = {
    ...tasks[index],
    ...req.body,
    id: tasks[index].id,
    createdAt: tasks[index].createdAt,
    updatedAt: new Date().toISOString()
  };

  logger.info(`Updated task: ${tasks[index].id}`);
  res.json(tasks[index]);
});

// DELETE task
router.delete('/:id', (req, res) => {
  const index = tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const removed = tasks.splice(index, 1);
  logger.info(`Deleted task: ${removed[0].id}`);
  res.status(204).send();
});

module.exports = router;
