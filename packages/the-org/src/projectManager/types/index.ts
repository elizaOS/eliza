import { type UUID } from '@elizaos/core';

// Define the days of the week for availability
export type WeekDay =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

// Define employment status types
export type EmploymentStatus = 'FULL_TIME' | 'PART_TIME' | 'FREELANCE' | 'NONE';

// Define report types
export type ReportType = 'DAILY' | 'WEEKLY' | 'MONTHLY';

// Define task status types
export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED';

// Define task priority levels
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

// Define platform types for multi-platform support
export type PlatformType = 'DISCORD' | 'TELEGRAM' | 'SLACK' | 'EMAIL';

/**
 * Interface for team member availability
 */
export interface Availability {
  workDays: WeekDay[];
  workHours: {
    start: string; // HH:MM format
    end: string; // HH:MM format
  };
  timeZone: string; // e.g., "America/Los_Angeles"
  hoursPerWeek: number;
  employmentStatus: EmploymentStatus;
}

/**
 * Interface for platform-specific contact information
 */
export interface PlatformContact {
  platform: PlatformType;
  username: string;
  isPreferred: boolean;
}

/**
 * Interface representing a team member
 */
export interface TeamMember {
  id: UUID;
  name: string;
  availability: Availability;
  contacts: PlatformContact[];
  skills?: string[];
  projects?: UUID[]; // Project IDs the team member is assigned to
  dateAdded: string; // ISO date format
  lastCheckIn?: string; // ISO date format
}

/**
 * Interface representing a task within a project
 */
export interface Task {
  id: UUID;
  projectId: UUID;
  title: string;
  description: string;
  assignedTo?: UUID; // Team member ID
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: string; // ISO date format
  createdAt: string; // ISO date format
  updatedAt: string; // ISO date format
  dependencies?: UUID[]; // IDs of tasks that this task depends on
  estimatedHours?: number;
}

/**
 * Interface representing a project milestone
 */
export interface Milestone {
  id: UUID;
  projectId: UUID;
  title: string;
  description: string;
  dueDate: string; // ISO date format
  tasks: UUID[]; // Task IDs associated with this milestone
  completed: boolean;
}

/**
 * Interface representing a project
 */
export interface Project {
  id: UUID;
  name: string;
  description: string;
  teamMembers: UUID[]; // Team member IDs
  startDate: string; // ISO date format
  targetEndDate?: string; // ISO date format
  actualEndDate?: string; // ISO date format
  client?: string;
  status: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
  createdAt: string; // ISO date format
  updatedAt: string; // ISO date format
}

/**
 * Interface representing daily updates from team members
 */
export interface DailyUpdate {
  id: UUID;
  teamMemberId: UUID;
  projectId: UUID;
  date: string; // ISO date format
  summary: string; // Paragraph summary of work done
  tasksCompleted?: UUID[]; // Task IDs completed
  tasksInProgress?: UUID[]; // Task IDs in progress
  blockers?: string[]; // Description of any blockers
  hoursWorked?: number;
}

/**
 * Interface for team member summaries in reports
 */
export interface TeamMemberSummary {
  teamMemberId: UUID;
  name: string;
  summary: string;
  tasksCompleted: number;
  tasksInProgress: number;
  hasBlockers: boolean;
}

/**
 * Interface representing a project progress metrics
 */
export interface ProjectProgress {
  projectId: UUID;
  date: string; // ISO date format
  tasksCompleted: number;
  tasksInProgress: number;
  tasksBlocked: number;
  tasksNotStarted: number;
  totalTasks: number;
  completionPercentage: number;
  teamMemberStats: {
    teamMemberId: UUID;
    tasksCompleted: number;
    tasksInProgress: number;
    hasUpdate: boolean;
  }[];
}

/**
 * Interface representing a generated report
 */
export interface Report {
  id: UUID;
  type: ReportType;
  projectId: UUID;
  generatedAt: string; // ISO date format
  summary: string;
  progressMetrics: {
    completionPercentage: number;
    tasksCompletedSinceLastReport: number;
    onTrackStatus: 'ON_TRACK' | 'AT_RISK' | 'DELAYED';
  };
  teamMemberSummaries: TeamMemberSummary[];
  milestoneUpdates?: {
    milestoneId: UUID;
    title: string;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
    dueDate: string; // ISO date format
    completionPercentage: number;
  }[];
}

/**
 * Interface for check-in status tracking
 */
export interface CheckInStatus {
  teamMemberId: UUID;
  projectId: UUID;
  lastCheckInDate?: string; // ISO date format
  nextCheckInDue: string; // ISO date format
  remindersSent: number;
  status: 'PENDING' | 'COMPLETED' | 'MISSED';
}
