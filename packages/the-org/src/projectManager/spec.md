# Technical Specification: Jimmy the Project Manager

## 1. Overview

Jimmy is an AI-powered project manager agent designed to help teams manage projects, track progress, coordinate team members, and generate reports. Jimmy operates primarily through Discord at first, then Telegram, Slack and others. He serves as a central coordination point for project management, ensuring team members are aligned on priorities and deadlines.

## 2. Core Functionality

Jimmy provides two main functions:

### Project Management

- Create and maintain projects
- Track project progress through daily updates
- Identify and report on blockers and risks
- Generate weekly status reports

### Team Coordination

- Add team members to projects
- Track work hours and availability
- Daily check-ins with team members
- Follow up on missing updates

## 3. Implementation

### Data Models

```typescript
interface Project {
  id: UUID;
  name: string;
  teamMembers: UUID[]; // Team member IDs
}

interface TeamMember {
  id: UUID;
  name: string;
  availability: {
    workDays: (
      | 'Monday'
      | 'Tuesday'
      | 'Wednesday'
      | 'Thursday'
      | 'Friday'
      | 'Saturday'
      | 'Sunday'
    )[];
    workHours: {
      start: string; // HH:MM format
      end: string; // HH:MM format
    };
    timeZone: string; // e.g., "America/Los_Angeles"
    hoursPerWeek: number;
    employmentStatus: 'FULL_TIME' | 'PART_TIME' | 'FREELANCE' | 'NONE';
  };
}

interface DailyUpdate {
  id: UUID;
  teamMemberId: UUID;
  projectId: UUID;
  date: string; // ISO date format
  summary: string; // Paragraph summary of work done
}

interface Report {
  id: UUID;
  type: 'DAILY' | 'WEEKLY';
  projectId: UUID;
  generatedAt: string;
  summary: string;
  teamMemberSummaries: {
    teamMemberId: UUID;
    name: string;
    summary: string;
  }[];
}
```

### Configuration

```typescript
interface ProjectConfig {
  id: UUID;
  name: string;
  team: UUID[]; // Team member IDs
}

interface TeamMemberConfig {
  id: UUID;
  name: string;
  workDays: string[];
  workHours: {
    start: string;
    end: string;
  };
  timeZone: string;
  hoursPerWeek: number;
  employmentStatus: 'FULL_TIME' | 'PART_TIME' | 'FREELANCE' | 'NONE';
}

const config: OnboardingConfig = {
  settings: {
    PROJECTS: {
      name: 'Projects',
      description: 'List of projects to manage',
      required: true,
      public: true,
      secret: false,
      value: [] as ProjectConfig[],
      validation: (value: ProjectConfig[]) => Array.isArray(value),
    },
    TEAM: {
      name: 'Team Members',
      description: 'List of team members',
      required: true,
      public: true,
      secret: false,
      value: [] as TeamMemberConfig[],
      validation: (value: TeamMemberConfig[]) => Array.isArray(value),
    },
    REPORT_CHANNEL: {
      name: 'Report Channel',
      description: 'Discord channel for reports (DMs if not specified)',
      required: false,
      public: true,
      secret: false,
      validation: (value: string) => typeof value === 'string',
    },
  },
};
```

### Character Definition

```typescript
const character: Character = {
  name: 'Jimmy',
  plugins: [
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-discord',
    '@elizaos/plugin-node',
    '@elizaos/plugin-sql',
  ],
  settings: {
    secrets: {
      DISCORD_APPLICATION_ID: process.env.PROJECT_MANAGER_DISCORD_APPLICATION_ID,
      DISCORD_API_TOKEN: process.env.PROJECT_MANAGER_DISCORD_API_TOKEN,
    },
  },
};
```

## 4. Workflows

### Onboarding

1. Jimmy joins server/team
2. Collects project and team information
3. Sets up data structures
4. Sends welcome message
5. Begins daily check-ins

### Daily Operations

1. Check in with each team member during their work hours
2. Follow up on missing updates
3. Generate end-of-week report after last team member update

### Weekly Report Format

```
📊 Project Summary:
[Overall progress and key points]

👥 Team Member Updates:
[Member Name]:
[Weekly work summary and current status]
```

## 5. Future Enhancements

- Linear Integration (task tracking, sprint planning)
- Google Meet Integration (meeting scheduling, calendar management)
- All-Hands Style Standups
- Sprint Goals Management with existing goals feature (weekly planning/retro)

# Original Notes

The above was extracted from these notes

# Script of example interactions

PM: Hey, I just need to get set up, you got a minute?
You: Sure
PM: What are you working on? Let's just pick one project or team to start small.
You: I'm building a SaaS AI email marketing company
PM: Great. Who else is on the team?
You: There's Jimmy, Gary and Laura.
PM: Okay cool, how should I contact them? Can you give me their preferred platform and username?
You: Yeah, Jimmy is jimmy.344 on Discord, Gary is garyisagenius, Laura is llwong1. All on Discord. Laura is also llwong1 on Telegram and seems ot be more responsive there.
PM: Got it. Can you tell me a bit about what each of them do and what they're working on?
You: Jimmy is our project manager, he's working on setting up our project management system and tracking tools. He's also helping coordinate between engineering and marketing. Gary is our compliance officer - he makes sure all our email campaigns and marketing materials follow regulations. He's currently reviewing our email templates and setting up compliance guidelines.
PM: Got it. And Laura?
You: Laura handles our marketing and social media. She's working on our social media strategy and creating content for our launch campaign. She's also designing some of our email templates. They're all pretty busy with the launch coming up, but they're good about responding to messages when you need them.
PM: Makes sense. Does the team have standups?
You: Not really, but I'd like to.
PM: Okay, how often do you want to have standups?
You: Monday and Thursday.
PM: Do you have a specific time that you know works for everyone on the team?
You: I think that 3pm PST works for everyone.
PM: Got it. Okay I think I have everything. I'll get in touch with all of them, if you could nudge them in a few minutes and let them know I've sent them a DM! And if you have any other team members I should check it with, just let me know!
You: Oh shoot. There's also Kelsey. She's our community manager. She's kind of the front door for a lot of new people, so we should keep her in the loop.
PM: No problem. How do I get in touch with her?
You: She's kelseyisthebest on Discord
PM: Okay got it!
PM: I tried to reach out to Kelsey, but her account is not accepting messages. Can you tell her to send me a DM?
You: Sure
<...>
PM: Okay, time for my daily report!

- I heard back from Laura and Kelsey. I'll give Gary a few more hours.
- Laura is working on a couple of marketing tasks, but she wasn't very specific
- Kelsey said she's just community managing and waiting for tasks
  All in all, I think Laura could be better utilized, and Kelsey is doing her job as I saw her chatting a lot with people in the Discord all day, but we could probably manage her with some tasks better. Let me know if you can get me in touch with Gary.
  You: Yeah he's not online today. Probably tomorrow.
  PM: Okay, no problem. I'll report back tomorrow with my update, let me know if you need anything!

PM: Hey there! I've been invited to join your team as a PM. I'd like to get a sense of your work hours and habits.
Employee: Yeah sure.
PM: Okay let's get started. How many hours per week do you work?
Employee: Uhh, like 45-50?
PM: Oh wow, that's a lot. Maybe too much. What are your start and end times?
Employee: I start at 10am and end around 8pm every day.
PM: What time zone are you in?
Employee: I'm in Montenegro.
PM: Okay, so you work 10am-8pm Monday through Friday on MNT?
Employee: That sounds right.
PM: Alright then. I'll reach out to you around 7pm every day. Just need a quick few bulletpoints or summary of what you got done for the day. Is there a time you are

PM: Hey there! I've been invited to join your team as a PM. I'd like to get a sense of your work hours and habits.
Freelancer: Uh I just work on this part time when asked, like when I have a ticket
PM: Okay, got it! Are you currently working on anything?
Freelancer: Uh yeah I've been working on setting up my laptop so I could run the project.
PM: Okay, do you have an idea of when you'll be done with that, and would you want more tasks after that?
Freelancer: Uh I should be done today, maybe tomorrow at the latest, then I'm free for whatever
PM: Okay got it. I'll get back to you!

Settings from owner
PROJECTS
TEAM MEMBERS
PROJECTS -> TEAM MEMBERS
REPORT CHANNEL
STANDUP TIMES
STANDUP LINKS (optional)

Settings from devs
HOURS_PER_WEEK
WORK HOURS (start and end times)
EMPLOYMENT_STATUS (full time, part time, none)

-> daily checkin start task
-> end of day checkin report task
-> weekly report task

Need to be able to create projects
Need to be able to create and associate entities from onboarding (onboarding handler?)
-> For example, devs on the project
Need to be able to add arrays of entities to projects
Need to be able to remove entities, too (just have an add + remove type)
Need a running service / timer that checks on task
Tasks should be stored in database
Need to be able to connect dev on discord/telegram to github
Need to be able to check dev commits every day and log them (including private commits / stuff on other projects)
After onboarding with server owner, need to onboard with members
From setting onboarding with times, need to create and destroy tasks for when to reach out to user

Future
Need linear integration
Need Google Meets / Calendar integration (for setting standups)

3. Project management agent
   -> Checks in with the team and creates reports for leadership one what everyone is doing and when
   -> Special abilities: Create projects, add users to projects, post daily updates from projects
   Once a user is added to the project, we need to get information from the user
   What are their work hours / days?
   Then contact the user every day at the time if they haven't already given their update for the day
   Then users are contacted at the time if they haven't already given their update for the day
   -> Special ability: Creating standup events
   -> Standup events are created by the project management agent on Discord or Google
   -> Set goals for the week with each person and see what we got done?
   -> process data
