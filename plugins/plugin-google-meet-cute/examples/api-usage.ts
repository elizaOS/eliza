/**
 * Example of using the @google-apps/meet API directly
 * This shows how the plugin internally uses the official Google Meet client
 */

import { SpacesServiceClient, ConferenceRecordsServiceClient } from '@google-apps/meet';
import { OAuth2Client } from 'google-auth-library';

// Initialize OAuth2 client
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Set credentials (you would get these from the OAuth flow)
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

// Create Meet API clients
const spacesClient = new SpacesServiceClient({ auth: oauth2Client as any });
const conferenceClient = new ConferenceRecordsServiceClient({ auth: oauth2Client as any });

async function createMeeting() {
  try {
    // Create a new meeting space
    const [space] = await spacesClient.createSpace({ 
      space: { 
        config: {
          accessType: 'OPEN',
          entryPointAccess: 'ALL'
        }
      } 
    });
    
    console.log('Meeting created!');
    console.log('Meeting URI:', space.meetingUri);
    console.log('Meeting Code:', space.meetingCode);
    console.log('Space Name:', space.name);
    
    return space;
  } catch (error) {
    console.error('Error creating meeting:', error);
  }
}

async function listParticipants(conferenceRecordName: string) {
  try {
    // List all participants in a conference
    const iterable = conferenceClient.listParticipantsAsync({
      parent: conferenceRecordName
    });

    console.log('Participants:');
    for await (const participant of iterable) {
      if (participant.signedinUser) {
        console.log('- Signed-in User:', participant.signedinUser.displayName);
      } else if (participant.anonymousUser) {
        console.log('- Anonymous User:', participant.anonymousUser.displayName);
      } else if (participant.phoneUser) {
        console.log('- Phone User:', participant.phoneUser.displayName);
      }
    }
  } catch (error) {
    console.error('Error listing participants:', error);
  }
}

async function getTranscript(transcriptName: string) {
  try {
    // Get transcript entries
    const iterable = conferenceClient.listTranscriptEntriesAsync({
      parent: transcriptName
    });

    console.log('Transcript:');
    for await (const entry of iterable) {
      console.log(`${entry.participant}: ${entry.text}`);
    }
  } catch (error) {
    console.error('Error getting transcript:', error);
  }
}

// Example usage
(async () => {
  // Create a meeting
  const space = await createMeeting();
  
  // After the meeting ends, you can access conference records
  // const conferenceRecordName = 'conferenceRecords/abc123';
  // await listParticipants(conferenceRecordName);
  // await getTranscript('conferenceRecords/abc123/transcripts/xyz789');
})(); 