# Test Messages for Memory Plugin

Use these messages to test the memory plugin's capabilities. Copy and paste them into your chat with the agent.

## Messages 1-10: Identity & Expertise

1. "Hi! I'm Sarah, a senior data scientist at a biotech startup."

2. "I work primarily with Python and R for statistical analysis."

3. "I'm not very familiar with frontend development, mostly do backend ML work."

4. "Remember that I have a PhD in computational biology."

5. "My team uses PostgreSQL for our main data warehouse."

6. "I've been working on a cancer research project for the past 6 months."

7. "Keep in mind that I prefer technical explanations with code examples."

8. "I'm preparing for a tech lead interview at a FAANG company."

9. "Don't forget I use Python 3.11 and pandas 2.0 in my current stack."

10. "By the way, I call our deployment process 'the pipeline' - it means staging + prod + rollback plan."

## Messages 11-20: Projects & Goals

11. "Can you help me with some data visualization questions?"

12. "I'm building a predictive model for patient outcomes using XGBoost."

13. "The model needs to handle imbalanced datasets - that's been my main challenge."

14. "Remember that my project deadline is end of Q2, so about 3 months."

15. "I need to present this to non-technical stakeholders, so visualizations are critical."

16. "What's the best way to explain ROC curves to executives?"

17. "Keep in mind I want to avoid overly complex charts - my CEO prefers simple bar charts."

18. "I'm also learning Rust on the side for a personal blockchain project."

19. "The blockchain project is just for fun, but I'm serious about understanding low-level systems."

20. "Remember I prefer learning by building actual projects rather than tutorials."

## Messages 21-30: Preferences & Constraints

21. "Can you suggest some resources for learning distributed systems?"

22. "I prefer books over video courses - I read on my commute."

23. "Don't forget that I work remotely from Seattle, Pacific timezone."

24. "My work schedule is pretty flexible, but I try to avoid meetings after 3pm."

25. "Remember that I'm vegan, so when suggesting lunch spots or recipes, keep that in mind."

26. "I use VS Code with Vim keybindings - been a Vim user for 10 years."

27. "Keep in mind I have ADHD, so I prefer concise responses with clear action items."

28. "I'm colorblind (red-green), so avoid using red/green in any visualizations you suggest."

29. "My pronouns are she/her by the way."

30. "Thanks for all the help! This has been really useful."

---

## Expected Memory Extractions

After these 30 messages, the plugin should extract:

**Identity:**

- User is Sarah, a senior data scientist
- Has PhD in computational biology
- Works at biotech startup
- Pronouns: she/her
- Location: Seattle (Pacific timezone)

**Expertise:**

- Expert in Python, R, statistical analysis
- Experienced with ML, pandas, XGBoost
- Not familiar with frontend development
- Learning Rust for blockchain
- Vim user for 10 years

**Projects:**

- Cancer research project (6 months)
- Building predictive model for patient outcomes
- Personal blockchain project (learning)

**Preferences:**

- Prefers technical explanations with code examples
- Likes concise responses with action items
- Prefers books over video tutorials
- Prefers simple visualizations (bar charts)
- Prefers learning by building projects

**Data Sources:**

- Uses Python 3.11, pandas 2.0
- PostgreSQL for data warehouse
- VS Code with Vim keybindings

**Goals:**

- Preparing for FAANG tech lead interview
- Project deadline: end of Q2 (3 months)
- Learning Rust and distributed systems

**Constraints:**

- Avoid meetings after 3pm
- Vegan dietary restriction
- Has ADHD - needs concise format
- Colorblind (red-green) - avoid those colors

**Definitions:**

- "the pipeline" = staging + prod + rollback plan

**Behavioral Patterns:**

- Prefers technical depth
- Works remotely
- Reads during commute

---

## Test Scenarios

### 1. Test Long-term Memory Extraction

After message #10, #20, and #30, check the `long_term_memories` table to see extracted facts.

### 2. Test Manual Memory Storage

Messages #4, #14, #17, #20, #25, #27, #28 contain explicit "remember" commands.

### 3. Test Memory Retrieval

In a new conversation, the agent should know:

- Sarah's name and background
- Her preferences for communication
- Her technical stack
- Her dietary restrictions
- Her accessibility needs (colorblindness)

### 4. Test Categorization

Check that memories are properly categorized into the 9 categories.

### 5. Test Confidence Scoring

Check confidence scores - explicit statements should have higher confidence (>0.9).
