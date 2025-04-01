/**
 * Type definitions for Project Manager
 */

import { UUID } from '@elizaos/core';

// Team member enums
export type WeekDay =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

export type EmploymentStatus = 'FULL_TIME' | 'PART_TIME' | 'CONTRACTOR' | 'INTERN';

export type PlatformType = 'DISCORD' | 'SLACK' | 'TELEGRAM' | 'EMAIL';

export type Skill = string;

// Platform-specific contact info
export interface PlatformContact {
  platform: PlatformType;
  identifier: string; // username, email, etc.
}

// Team member availability
export interface Availability {
  workDays?: WeekDay[];
  workHoursStart: string; // 24-hour format HH:MM
  workHoursEnd: string; // 24-hour format HH:MM
  timeZone: string; // e.g., 'America/New_York', 'UTC'
}

// Team member interface
export interface TeamMember {
  id: UUID;
  name: string;
  availability: Availability;
  employmentStatus: EmploymentStatus;
  hoursPerWeek: number;
  skills?: Skill[];
  contacts: PlatformContact[];
  createdAt: string;
  updatedAt: string;
}

// Project status types
export type ProjectStatus = 'PLANNING' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'CANCELLED';

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

// Task interface
export interface Task {
  id: UUID;
  name: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: UUID; // TeamMember ID
  dependsOn?: UUID[]; // Task IDs
  estimatedHours?: number;
  actualHours?: number;
  createdAt: string;
  updatedAt: string;
  dueDate?: string;
}

// Milestone interface
export interface Milestone {
  id: UUID;
  name: string;
  description: string;
  tasks: UUID[]; // Task IDs
  dueDate: string;
  completedAt?: string;
}

// Progress metrics
export interface ProjectProgress {
  date: string;
  completedTasks: number;
  totalTasks: number;
  completedMilestones: number;
  totalMilestones: number;
  blockedTasks: number;
}

// Project interface
export interface Project {
  id: UUID;
  name: string;
  description: string;
  status: ProjectStatus;
  teamMembers: UUID[]; // TeamMember IDs
  tasks: Task[];
  milestones: Milestone[];
  progress: ProjectProgress[];
  startDate: string;
  targetEndDate: string;
  actualEndDate?: string;
  createdAt: string;
  updatedAt: string;
}

// Daily update types
export type UpdateType = 'CHECK_IN' | 'STATUS_UPDATE' | 'BLOCKER_REPORT';

// Daily update interface
export interface DailyUpdate {
  id?: UUID;
  teamMemberId: UUID;
  projectId?: UUID;
  updateType: UpdateType;
  completedItems?: string[];
  inProgressItems?: string[];
  blockers?: string[];
  notes?: string;
  timestamp: string;
}

export interface TeamMemberUpdate {
  type: 'team-member-update';
  updateId: UUID;
  teamMemberId: UUID;
  teamMemberName?: string;
  serverName: string;
  checkInType: string;
  currentProgress: string;
  workingOn: string;
  nextSteps: string;
  blockers: string;
  eta: string;
  timestamp: string;
  channelId?: UUID;
  serverId?: string;
}
