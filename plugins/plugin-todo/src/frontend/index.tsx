import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import './index.css';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from './ui/card';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import Loader from './loader';
import { cn } from './utils';
import { PlusCircle } from 'lucide-react';

// Define Task type based on backend structure
// NOTE: Adjust this type based on the actual structure returned by IAgentRuntime and modified by API routes
interface TaskMetadata {
  dueDate?: string; // ISO string
  completedToday?: boolean;
  lastReminderSent?: string; // ISO string
  completedAt?: string; // ISO string
  [key: string]: any; // Allow other metadata properties
}

interface Task {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: TaskMetadata;
  roomId: string; // Added roomId as it's crucial
  // Add other relevant fields like createdAt, updatedAt if needed
}

interface RoomWithTasks {
  roomId: string;
  roomName: string;
  tasks: Task[];
}

interface WorldWithRooms {
  worldId: string;
  worldName: string;
  rooms: RoomWithTasks[];
}

// --- NEW: Interface for Task Identifiers ---
interface TaskIdentifier {
  id: string;
  name: string;
  entityId?: string; // Make optional if they can be null/undefined
  roomId?: string;
  worldId?: string;
}

const queryClient = new QueryClient();

// Helper to extract context from URL
const getContextFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: params.get('roomId'),
    entityId: params.get('entityId'),
    worldId: params.get('worldId'),
  };
};

// --- API Interaction Hooks ---

const useTodos = () => {
  return useQuery<WorldWithRooms[], Error>({
    queryKey: ['todosStructured'],
    queryFn: async () => {
      const response = await fetch('/api/todos');
      if (!response.ok) {
        throw new Error('Network response was not ok');
      }
      return response.json();
    },
  });
};

// --- Hook to fetch tags ---
const useTags = () => {
  return useQuery<string[], Error>({
    queryKey: ['taskTags'],
    queryFn: async () => {
      const response = await fetch('/api/tags');
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to fetch tags: ${errorData}`);
      }
      return response.json();
    },
  });
};

// --- Hook to fetch ALL tasks (for debugging) ---
const useAllTasks = () => {
  return useQuery<TaskIdentifier[], Error>({
    queryKey: ['allTasks'],
    queryFn: async () => {
      const response = await fetch('/api/all-tasks'); // Use new endpoint
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to fetch all tasks: ${errorData}`);
      }
      return response.json();
    },
  });
};

const useAddTask = () => {
  const queryClient = useQueryClient();

  return useMutation<
    Task,
    Error,
    Omit<Task, 'id'> & {
      type: string;
      isUrgent?: boolean;
      priority?: number;
      roomId: string;
    }
  >({
    mutationFn: async (newTaskData) => {
      if (!newTaskData.roomId) {
        throw new Error('Room ID is required to add a task.');
      }
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newTaskData),
      });
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to add task: ${errorData}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['todosStructured'] });
      queryClient.invalidateQueries({ queryKey: ['allTasks'] }); // Invalidate all tasks too
    },
  });
};

const useCompleteTask = () => {
  const queryClient = useQueryClient();

  return useMutation<
    any,
    Error,
    { taskId: string }
  >({
    mutationFn: async ({ taskId }) => {
      const response = await fetch(`/api/todos/${taskId}/complete`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to complete task: ${errorData}`);
      }
      return response.json();
    },
    onSuccess: (data, { taskId }) => {
      console.log(`Task ${taskId} completed:`, data.message);
      queryClient.invalidateQueries({ queryKey: ['todosStructured'] });
      queryClient.invalidateQueries({ queryKey: ['allTasks'] });
    },
    onError: (error, { taskId }) => {
      console.error(`Error completing task ${taskId}:`, error);
    },
  });
};

const useUncompleteTask = () => {
  const queryClient = useQueryClient();
  return useMutation<any, Error, string>({
    mutationFn: async (taskId) => {
      const response = await fetch(`/api/todos/${taskId}/uncomplete`, {
        method: 'PUT',
      });
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to uncomplete task: ${errorData}`);
      }
      return response.json();
    },
    onSuccess: (data, taskId) => {
      console.log(`Task ${taskId} uncompleted:`, data.message);
      queryClient.invalidateQueries({ queryKey: ['todosStructured'] });
      queryClient.invalidateQueries({ queryKey: ['allTasks'] });
    },
    onError: (error, taskId) => {
      console.error(`Error uncompleting task ${taskId}:`, error);
    },
  });
};

const useDeleteTask = () => {
  const queryClient = useQueryClient();
  return useMutation<any, Error, string>({
    mutationFn: async (taskId) => {
      const response = await fetch(`/api/todos/${taskId}`, {
        method: 'DELETE',
      });
      if (
        response.ok &&
        response.status !== 204 &&
        response.headers.get('content-length') !== '0'
      ) {
        return response.json();
      } else if (response.ok) {
        return { message: `Task ${taskId} deleted successfully` };
      } else {
        const errorData = await response.text();
        throw new Error(`Failed to delete task: ${errorData || response.statusText}`);
      }
    },
    onSuccess: (data, taskId) => {
      console.log(`Task ${taskId} deletion success:`, data?.message || 'Deleted');
      queryClient.invalidateQueries({ queryKey: ['todosStructured'] });
      queryClient.invalidateQueries({ queryKey: ['allTasks'] });
    },
    onError: (error, taskId) => {
      console.error(`Error deleting task ${taskId}:`, error);
    },
  });
};

const useCreateRoom = () => {
  const queryClient = useQueryClient();
  return useMutation<any, Error, { worldId: string; name: string }>({
    mutationFn: async ({ worldId, name }) => {
      const response = await fetch(`/api/worlds/${worldId}/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Failed to create room: ${errorData}`);
      }
      return response.json();
    },
    onSuccess: (newRoomData) => {
      console.log(`Room created successfully:`, newRoomData);
      queryClient.invalidateQueries({ queryKey: ['todosStructured'] });
    },
    onError: (error) => {
      console.error('Error creating room:', error);
      alert(`Error creating room: ${error.message}`);
    },
  });
};

// --- Components ---

const AddTaskForm = ({ worlds }: { worlds: WorldWithRooms[] }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('one-off');
  const [priority, setPriority] = useState('4');
  const [dueDate, setDueDate] = useState('');
  const [isUrgent, setIsUrgent] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState<string>('');
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const addTaskMutation = useAddTask();

  const availableRooms = worlds.find((w) => w.worldId === selectedWorldId)?.rooms || [];

  useEffect(() => {
    setSelectedRoomId('');
  }, [selectedWorldId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !selectedRoomId) {
      alert('Please enter a task name and select a world/room.');
      return;
    }
    const taskData: any = { name: name.trim(), type, roomId: selectedRoomId };
    if (type === 'one-off') {
      taskData.priority = parseInt(priority, 10);
      if (dueDate) taskData.dueDate = dueDate;
      taskData.isUrgent = isUrgent;
    }
    addTaskMutation.mutate(taskData, {
      onSuccess: () => {
        setName('');
        setType('one-off');
        setPriority('4');
        setDueDate('');
        setIsUrgent(false);
      },
      onError: (error) => {
        alert(`Error adding task: ${error.message}`);
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add New Task</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="world-select">World</Label>
            <Select value={selectedWorldId} onValueChange={setSelectedWorldId} required>
              <SelectTrigger id="world-select" data-testid="world-select">
                <SelectValue placeholder="Select World" />
              </SelectTrigger>
              <SelectContent>
                {worlds.map((world, index) => (
                  <SelectItem
                    key={world.worldId}
                    value={world.worldId}
                    data-testid={`world-option-${index + 1}`}
                  >
                    {world.worldName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedWorldId && (
            <div className="space-y-2">
              <Label htmlFor="room-select">Room</Label>
              <Select
                value={selectedRoomId}
                onValueChange={setSelectedRoomId}
                required
                disabled={!selectedWorldId || availableRooms.length === 0}
              >
                <SelectTrigger id="room-select" data-testid="room-select">
                  <SelectValue
                    placeholder={availableRooms.length > 0 ? 'Select Room' : 'No rooms in world'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableRooms.map((room, index) => (
                    <SelectItem
                      key={room.roomId}
                      value={room.roomId}
                      data-testid={`room-option-${index + 1}`}
                    >
                      {room.roomName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Separator />

          <div className="space-y-2">
            <Label htmlFor="task-name">Task Name</Label>
            <Input
              id="task-name"
              data-testid="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What needs to be done?"
              required
              disabled={!selectedRoomId}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-type">Type</Label>
            <Select value={type} onValueChange={setType} disabled={!selectedRoomId}>
              <SelectTrigger id="task-type" data-testid="task-type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one-off">One-off</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="aspirational">Aspirational</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === 'one-off' && (
            <div className="pl-4 border-l-2 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="task-priority">Priority (1=High)</Label>
                <Select value={priority} onValueChange={setPriority} disabled={!selectedRoomId}>
                  <SelectTrigger id="task-priority" data-testid="task-priority">
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="4">4</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="task-due-date">Due Date</Label>
                <Input
                  id="task-due-date"
                  data-testid="task-due-date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={!selectedRoomId}
                />
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="task-urgent"
                  data-testid="task-urgent"
                  checked={isUrgent}
                  onCheckedChange={(checked) => setIsUrgent(checked === true)}
                  disabled={!selectedRoomId}
                  aria-labelledby="task-urgent-label"
                />
                <Label
                  htmlFor="task-urgent"
                  id="task-urgent-label"
                  className="font-normal cursor-pointer"
                >
                  Urgent
                </Label>
              </div>
            </div>
          )}

          <Button
            type="submit"
            data-testid="create-todo-btn"
            disabled={addTaskMutation.isPending || !selectedRoomId}
          >
            {addTaskMutation.isPending ? <Loader /> : 'Add Task'}
          </Button>
          {addTaskMutation.isError && (
            <p className="text-red-500 text-sm">Error: {addTaskMutation.error.message}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
};

const TaskItem = ({ task }: { task: Task }) => {
  const completeTaskMutation = useCompleteTask();
  const uncompleteTaskMutation = useUncompleteTask();
  const deleteTaskMutation = useDeleteTask();
  const isCompleted = task.tags?.includes('completed');

  const handleCheckboxChange = () => {
    if (isCompleted) {
      uncompleteTaskMutation.mutate(task.id);
    } else {
      completeTaskMutation.mutate({ taskId: task.id });
    }
  };

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete task "${task.name}"?`)) {
      deleteTaskMutation.mutate(task.id);
    }
  };

  let details = '';
  if (task.tags?.includes('daily')) {
    details = `(Daily)`;
  } else if (task.tags?.includes('one-off')) {
    const priority = task.tags?.find((t) => t.startsWith('priority-'))?.split('-')[1] ?? '4';
    const urgent = task.tags?.includes('urgent') ? ' 🔴 Urgent' : '';
    const dueDate = task.metadata?.dueDate
      ? ` Due: ${new Date(task.metadata.dueDate).toLocaleDateString()}`
      : '';
    details = `(P${priority}${urgent}${dueDate})`;
  } else if (task.tags?.includes('aspirational')) {
    details = '(Aspirational Goal)';
  }

  const completedDate = task.metadata?.completedAt
    ? new Date(task.metadata.completedAt).toLocaleDateString()
    : '';

  return (
    <div
      data-testid="todo-item"
      className={cn(
        'flex items-center justify-between p-2 rounded hover:bg-muted/50',
        isCompleted && 'opacity-60'
      )}
    >
      <div className="flex items-center space-x-3 flex-grow min-w-0">
        <Checkbox
          id={`task-${task.id}`}
          data-testid="todo-checkbox"
          checked={isCompleted}
          onCheckedChange={handleCheckboxChange}
          disabled={completeTaskMutation.isPending || uncompleteTaskMutation.isPending}
          aria-label={isCompleted ? 'Mark task as incomplete' : 'Mark task as complete'}
          aria-labelledby={`task-label-${task.id}`}
        />
        <Label
          htmlFor={`task-${task.id}`}
          id={`task-label-${task.id}`}
          className={cn('flex-grow truncate cursor-pointer', isCompleted && 'line-through')}
        >
          {task.name}
          <span className="text-xs text-muted-foreground ml-1">{details}</span>
          {isCompleted && (
            <span className="text-xs text-green-600 ml-2">
              (Completed {completedDate})
            </span>
          )}
        </Label>
      </div>
      <div className="flex items-center space-x-1 flex-shrink-0 ml-2">
        {(completeTaskMutation.isPending || uncompleteTaskMutation.isPending) && <Loader />}
        <Button
          variant="ghost"
          size="sm"
          data-testid="delete-todo-btn"
          onClick={handleDelete}
          disabled={deleteTaskMutation.isPending}
          aria-label="Delete task"
          className="hover:bg-destructive/10 text-muted-foreground hover:text-destructive p-1 h-auto"
        >
          {deleteTaskMutation.isPending ? <Loader /> : '🗑️'}
        </Button>
      </div>
    </div>
  );
};

const TagsList = () => {
  const { data: tags, isLoading, error } = useTags();

  return (
    <Card>
      <CardHeader>
        <CardTitle>All Task Tags</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Loader />}
        {error && <p className="text-red-500 text-sm">Error loading tags: {error.message}</p>}
        {tags && tags.length === 0 && (
          <p className="text-muted-foreground text-sm">No tags found.</p>
        )}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 bg-muted text-muted-foreground rounded-full text-xs"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// --- Component to display ALL tasks --- MODIFY THIS COMPONENT
const AllTasksList = () => {
  const { data: allTasks, isLoading, error } = useAllTasks(); // Fetch TaskIdentifier[]

  return (
    <Card>
      <CardHeader>
        <CardTitle>All Tasks (Debug)</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <Loader />}
        {error && <p className="text-red-500 text-sm">Error loading all tasks: {error.message}</p>}
        {allTasks && allTasks.length === 0 && (
          <p className="text-muted-foreground text-sm">No tasks found in the database.</p>
        )}
        {allTasks && allTasks.length > 0 && (
          <div className="space-y-1 max-h-96 overflow-y-auto text-xs">
            {/* Render the identifiers directly */}
            {allTasks.map((task) => (
              <div key={task.id} className="p-1 border-b border-dashed last:border-b-0">
                <p>
                  <strong>Name:</strong> {task.name}
                </p>
                <p>
                  <strong>ID:</strong> {task.id}
                </p>
                <p>
                  <strong>RoomID:</strong> {task.roomId || 'N/A'}
                </p>
                <p>
                  <strong>WorldID:</strong> {task.worldId || 'N/A'}
                </p>
                <p>
                  <strong>EntityID:</strong> {task.entityId || 'N/A'}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
// --- END ALL TASKS COMPONENT ---

function App() {
  const { data: worlds, isLoading, error, isSuccess } = useTodos();
  const createRoomMutation = useCreateRoom();

  useEffect(() => {
    if (isSuccess) {
      console.log('Fetched Worlds Data:', worlds);
    }
    if (error) {
      console.error('useTodos Error:', error);
    }
  }, [worlds, isSuccess, error]);

  const handleAddRoom = (worldId: string) => {
    const roomName = prompt('Enter the name for the new room:');
    if (roomName && roomName.trim()) {
      createRoomMutation.mutate({ worldId, name: roomName.trim() });
    } else if (roomName !== null) {
      alert('Room name cannot be empty.');
    }
  };

  return (
    <div data-testid="todo-app" className="flex flex-col gap-6 my-4 bg-background min-h-screen">
      <div className="container flex items-center gap-4 py-4 border-b">
        <div className="text-3xl font-bold">📝 Task Manager (All Worlds)</div>
      </div>

      <div className="container flex flex-col lg:flex-row gap-6">
        {/* Left Column: Add Task Form, Tags List, All Tasks List */}
        <div className="lg:w-1/3 space-y-4 flex-shrink-0">
          <AddTaskForm worlds={worlds ?? []} />
          <TagsList />
          <AllTasksList />
        </div>

        {/* Right Column: Task List by World/Room */}
        <div className="lg:w-2/3 space-y-6">
          {isLoading && <Loader data-testid="loader" />}
          {error && <p className="text-red-500">Error loading tasks: {error.message}</p>}

          {!isLoading && !error && (!worlds || worlds.length === 0) && (
            <Card>
              <CardContent className="pt-6">
                <p className="text-muted-foreground text-center">
                  No worlds with TODO tasks found.
                </p>
              </CardContent>
            </Card>
          )}

          {worlds &&
            worlds.map((world) => (
              <Collapsible
                key={world.worldId}
                defaultOpen
                className="space-y-2"
                data-testid="world-section"
              >
                <div className="flex items-center justify-between">
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="link"
                      data-testid="world-toggle"
                      className="text-xl font-semibold p-0 text-left hover:no-underline"
                    >
                      {world.worldName}
                    </Button>
                  </CollapsibleTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="add-room-btn"
                    onClick={() => handleAddRoom(world.worldId)}
                    disabled={createRoomMutation.isPending}
                    aria-label="Add new room to this world"
                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    {createRoomMutation.isPending ? <Loader /> : <PlusCircle className="size-4" />}
                    Add Room
                  </Button>
                </div>
                <CollapsibleContent className="space-y-4 pl-4 border-l-2" data-testid="world-rooms">
                  {world.rooms.length === 0 && (
                    <p className="text-muted-foreground text-sm italic pl-2">
                      No rooms with tasks in this world yet.
                    </p>
                  )}
                  {world.rooms.map((room) => (
                    <Card
                      key={room.roomId}
                      data-testid="room-section"
                      className="border shadow-sm ml-2 p-1 bg-card"
                    >
                      <CardHeader className="p-2 pb-1">
                        <CardTitle className="text-base font-medium" data-testid="room-name">
                          {room.roomName}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-1 p-2 pt-1">
                        {room.tasks.filter((task) => !task.tags?.includes('completed')).length >
                        0 ? (
                          room.tasks
                            .filter((task) => !task.tags?.includes('completed'))
                            .map((task) => <TaskItem key={task.id} task={task} />)
                        ) : (
                          <p className="text-muted-foreground text-xs px-2 py-1">
                            No pending tasks in this room.
                          </p>
                        )}
                        {room.tasks.some((task) => task.tags?.includes('completed')) && (
                          <>
                            <Separator className="my-2" />
                            <div className="space-y-1" data-testid="completed-section">
                              {room.tasks
                                .filter((task) => task.tags?.includes('completed'))
                                .map((task) => (
                                  <TaskItem key={task.id} task={task} />
                                ))}
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            ))}
        </div>
      </div>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  );
} else {
  console.error('Failed to find the root element');
}
