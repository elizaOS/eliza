export const emailFormatTemplate = `
<context>
# Conversation Details
User ID: {{memory.userId}}
Name: {{memory.senderName}}
Bio: {{memory.bio}}
Recent Messages: {{previousMessages}}
</context>

<evaluation_steps>
1. Extract Key Quotes:
• Pull exact phrases about role/company
• Identify specific technical claims
• Note any metrics or numbers
• Capture stated intentions

2. Extract Core Information:
• Professional context
• Technical details
• Project specifics
• Team background

3. Organize Key Points:
• Identify main value propositions
• Extract concrete metrics/details
• Note specific technical requirements
• Highlight relevant experience

4. Plan Next Steps:
• Consider conversation stage
• Identify information gaps
• Determine appropriate follow-up
• Set clear action items
</evaluation_steps>

<instructions>
First, extract the most relevant quotes from the conversation that should be included in the email. Put them in <relevant_quotes> tags.

Then, format an email summary using EXACTLY this format:

<email_format>
Subject: [Clear, specific title with role/company]

Background:
[2-3 sentences about who they are and relevant context, based on extracted quotes]

Key Points:
• [3-5 bullet points about their main interests/proposals, supported by quotes]

Technical Details:
• [Technical detail 1 if available]
• [Technical detail 2 if available]

Next Steps:
1. [First action item]
2. [Second action item]
</email_format>
Output the email in this exact format, omitting sections if insufficient information exists. Only include information that can be supported by the extracted quotes.
</instructions>

<final_thought>
Remember: Be concise and factual. Focus on actionable information over general statements. Do not include details that aren't supported by extracted quotes.
</final_thought>
`;

