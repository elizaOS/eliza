# Task Manager API

A lightweight RESTful API for managing tasks and to-do items.

## Quick Start

```bash
npm install
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/tasks | List all tasks |
| GET | /api/tasks/:id | Get task by ID |
| POST | /api/tasks | Create new task |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| GET | /api/health | Health check |

## Query Parameters

- `status` - Filter by status (todo, in_progress, done)
- `priority` - Filter by priority (low, medium, high)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| NODE_ENV | development | Environment |
| LOG_LEVEL | info | Winston log level |

## Development

```bash
npm run dev    # Start with nodemon
npm test       # Run tests
npm run lint   # Lint code
```

## License

MIT
