// import {
//   type IAgentRuntime,
//   type Memory,
//   type UUID,
//   createUniqueUuid,
//   logger,
// } from '@elizaos/core';
// import type { TeamMember, DailyUpdate } from '../../../types';

// /**
//  * Interface for team member memory content
//  */
// interface TeamMemberContent {
//   type: 'team-member';
//   member: TeamMember;
//   discordHandle?: string;
// }

// /**
//  * Interface for daily update memory content
//  */
// interface DailyUpdateContent {
//   type: 'daily-update';
//   update: DailyUpdate;
// }

// /**
//  * Service for managing team coordination functionality
//  * Handles team member management, availability tracking, and check-ins
//  */
// export class TeamCoordinatorService {
//   private runtime: IAgentRuntime;
//   private teamMembersRoomId: UUID;

//   constructor(runtime: IAgentRuntime) {
//     this.runtime = runtime;
//     this.teamMembersRoomId = createUniqueUuid(runtime, 'team-members');
//   }

//   /**
//    * Get all team members
//    */
//   async getAllTeamMembers(): Promise<TeamMember[]> {
//     try {
//       // Retrieve all team member memories from the room
//       const memoryManager = this.runtime.getMemoryManager('messages');
//       const memories = await memoryManager.getMemories({
//         roomId: this.teamMembersRoomId,
//       });

//       // Convert memories to TeamMember objects
//       return memories
//         .filter((memory) => memory.content && (memory.content as any).type === 'team-member')
//         .map((memory) => (memory.content as any as TeamMemberContent).member);
//     } catch (error) {
//       logger.error(`Error getting team members: ${error}`);
//       return [];
//     }
//   }

//   /**
//    * Get a team member by ID
//    */
//   async getTeamMemberById(teamMemberId: string): Promise<TeamMember | null> {
//     try {
//       const teamMembers = await this.getAllTeamMembers();
//       return teamMembers.find((member) => member.id === teamMemberId) || null;
//     } catch (error) {
//       logger.error(`Error getting team member by ID: ${error}`);
//       return null;
//     }
//   }

//   /**
//    * Create a new team member
//    */
//   async createTeamMember(teamMember: TeamMember, discordHandle?: string): Promise<boolean> {
//     try {
//       const memoryManager = this.runtime.getMemoryManager('messages');
//       await memoryManager.createMemory({
//         roomId: this.teamMembersRoomId,
//         content: {
//           type: 'team-member',
//           member: teamMember,
//           discordHandle,
//         },
//       });
//       return true;
//     } catch (error) {
//       logger.error(`Error creating team member: ${error}`);
//       return false;
//     }
//   }

//   /**
//    * Update an existing team member
//    */
//   async updateTeamMember(teamMember: TeamMember, discordHandle?: string): Promise<boolean> {
//     try {
//       // Find the existing memory
//       const memories = await this.runtime.getMemories({
//         roomId: this.teamMembersRoomId,
//         type: 'team-member',
//       });

//       const existingMemory = memories.find(
//         (memory) =>
//           memory.content &&
//           memory.content.type === 'team-member' &&
//           (memory.content as TeamMemberContent).member.id === teamMember.id
//       );

//       if (!existingMemory) {
//         logger.warn(`Team member with ID ${teamMember.id} not found for update`);
//         return false;
//       }

//       // Update the memory
//       await this.runtime.updateMemory({
//         memoryId: existingMemory.id,
//         content: {
//           type: 'team-member',
//           member: teamMember,
//           discordHandle:
//             discordHandle || (existingMemory.content as TeamMemberContent).discordHandle,
//         },
//       });
//       return true;
//     } catch (error) {
//       logger.error(`Error updating team member: ${error}`);
//       return false;
//     }
//   }

//   /**
//    * Record a daily check-in for a team member
//    */
//   async recordDailyUpdate(teamMemberId: string, update: DailyUpdate): Promise<boolean> {
//     try {
//       const checkInsRoomId = createUniqueUuid(this.runtime, 'daily-updates');

//       await this.runtime.createMemory({
//         roomId: checkInsRoomId,
//         content: {
//           type: 'daily-update',
//           update: {
//             ...update,
//             teamMemberId,
//             timestamp: new Date().toISOString(),
//           },
//         },
//       });
//       return true;
//     } catch (error) {
//       logger.error(`Error recording daily update: ${error}`);
//       return false;
//     }
//   }

//   /**
//    * Get latest daily update for a team member
//    */
//   async getLatestDailyUpdate(teamMemberId: string): Promise<DailyUpdate | null> {
//     try {
//       const checkInsRoomId = createUniqueUuid(this.runtime, 'daily-updates');

//       const memories = await this.runtime.getMemories({
//         roomId: checkInsRoomId,
//         type: 'daily-update',
//       });

//       // Filter updates for this team member and sort by timestamp
//       const memberUpdates = memories
//         .filter(
//           (memory) =>
//             memory.content &&
//             memory.content.type === 'daily-update' &&
//             (memory.content as DailyUpdateContent).update.teamMemberId === teamMemberId
//         )
//         .map((memory) => (memory.content as DailyUpdateContent).update)
//         .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

//       return memberUpdates.length > 0 ? memberUpdates[0] : null;
//     } catch (error) {
//       logger.error(`Error getting latest daily update: ${error}`);
//       return null;
//     }
//   }
// }
