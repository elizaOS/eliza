TODO

We have to make some changes to the UI

1. For each group or DM i want to have a dropdown list of prior chats, and i can go back to these and continue the conversation. Need to get all rooms where I share with the agent, and store this on the message server.

2. For the Create dropdown, I'd like to switch that to be a button that has a "+" and is next to "Online" which should say "Agents" instead of Online (i've change it)

3. The tabs for logs, actions and memories have disappeared from the right. We should have the Details tab be the first tab, and then these tabs

4. We should let the user configure all of the settings for the agent and save them from the Agent Details page, with the subsections and everything, instead of being bured in a settings menu on the home page of the agent-- so this is moved to a sidebar tab basically
   Currently all of that stuff is on settings page: http://localhost:3000/settings/b850bc30-45f8-0041-a00a-83df46d8555d

5. We can see the icon for each agent in the group, and we can click on any and their icon will be selected and we will see their tabs on right for logs, memories, details, etc

6. When clicking on the logo, we should see the state be cleared and we return home-- currently the URL changes but hte state doesnt change

7. Same when clicking between groups -- state is not cleared, so messages stay there

8. We have two different group create/edit modals. We should consolidate this

9. Group name should be the list of agents int he group, and it should dynamically change if agents are added or removed

10. Randomly assign an image from public/images/agents/ to each agent if their image is null, instead of being gray
