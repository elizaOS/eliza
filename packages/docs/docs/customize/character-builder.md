# Character Builder Studio

Transform your AI agent with our visual character design tool. Create unique personalities without writing code using our interactive Character Builder Studio.

## 🎭 What Is Character Builder?

Character Builder is an intuitive visual tool that helps you craft the perfect AI personality. Instead of editing JSON files, you'll use sliders, dropdowns, and real-time previews to design your agent's character.

### Key Features

- 🎨 **Visual Personality Designer** - Drag-and-drop interface for traits
- 💬 **Live Chat Preview** - Test your character as you build
- 🧠 **AI Personality Assistant** - Get suggestions based on your goals
- ✅ **Consistency Validation** - Ensure coherent personality traits
- 📱 **Multi-Platform Preview** - See how it looks on Discord, Telegram, etc.
- 🔄 **One-Click Export** - Generate working character files instantly

## 🚀 Quick Start Guide

### Step 1: Access the Builder

```bash
# Option 1: Web Interface (Recommended)
bun start --character-builder

# Option 2: CLI Interface
elizaos character create --interactive

# Option 3: Online Tool
# Visit: https://elizaos.org/character-builder
```

### Step 2: Choose Your Starting Point

#### 🌟 Start from Template

Pick from our curated personality templates:

- **Professional Assistant** - Business-focused, efficient, formal
- **Creative Companion** - Artistic, inspiring, imaginative
- **Tech Expert** - Precise, knowledgeable, helpful
- **Community Manager** - Friendly, engaging, social
- **Gaming Buddy** - Enthusiastic, competitive, fun
- **Wellness Coach** - Supportive, calming, encouraging

#### 🎨 Build from Scratch

Start with a blank canvas and design everything yourself

#### 📂 Import Existing

Upload your current character file to modify and enhance

### Step 3: Design Your Character

## 🎨 Character Design Interface

### Personality Traits Panel

<div className="personality-builder">
  <div className="trait-section">
    <h4>Core Personality (Required)</h4>
    
    <div className="trait-input">
      <label>Agent Name</label>
      <input type="text" placeholder="e.g. Alex, Assistant, Bot..." />
      <div className="validation-live">
        <span className="validation-icon">✅</span>
        <span className="validation-text">Great! Short and memorable</span>
      </div>
    </div>

    <div className="trait-input">
      <label>Primary Role</label>
      <select>
        <option>Customer Support</option>
        <option>Creative Assistant</option>
        <option>Technical Expert</option>
        <option>Community Manager</option>
        <option>Personal Assistant</option>
        <option>Gaming Companion</option>
      </select>
      <div className="validation-live">
        <span className="validation-icon">ℹ️</span>
        <span className="validation-text">This will optimize default responses and capabilities</span>
      </div>
    </div>

    <div className="trait-input">
      <label>Personality Type (MBTI)</label>
      <select>
        <option>ENFJ - The Protagonist</option>
        <option>INFP - The Mediator</option>
        <option>ENTJ - The Commander</option>
        <option>INTP - The Thinker</option>
        <option>ESFP - The Entertainer</option>
        <option>ISFJ - The Protector</option>
      </select>
      <div className="personality-preview">
        <div className="preview-traits">
          <span className="trait-tag">Charismatic</span>
          <span className="trait-tag">Inspiring</span>
          <span className="trait-tag">Empathetic</span>
        </div>
      </div>
    </div>

    <div className="trait-slider">
      <label>Energy Level</label>
      <div className="slider-container">
        <span className="slider-label">Calm</span>
        <input type="range" min="1" max="10" value="7" className="trait-range" />
        <span className="slider-label">Energetic</span>
      </div>
      <div className="slider-value">7/10 - Enthusiastic and engaging</div>
      <div className="validation-live success">
        <span className="validation-icon">✅</span>
        <span className="validation-text">Perfect for community engagement</span>
      </div>
    </div>

    <div className="trait-slider">
      <label>Communication Style</label>
      <div className="slider-container">
        <span className="slider-label">Formal</span>
        <input type="range" min="1" max="10" value="8" className="trait-range" />
        <span className="slider-label">Casual</span>
      </div>
      <div className="slider-value">8/10 - Very casual and friendly</div>
      <div className="validation-live warning">
        <span className="validation-icon">⚠️</span>
        <span className="validation-text">May be too casual for business contexts</span>
      </div>
    </div>

  </div>

  <div className="trait-section">
    <h4>Advanced Traits (Optional)</h4>
    
    <div className="trait-selector">
      <label>Humor Style</label>
      <div className="option-grid">
        <div className="option-card active">
          <div className="option-icon">😄</div>
          <div className="option-name">Witty</div>
        </div>
        <div className="option-card">
          <div className="option-icon">😏</div>
          <div className="option-name">Sarcastic</div>
        </div>
        <div className="option-card">
          <div className="option-icon">😊</div>
          <div className="option-name">Wholesome</div>
        </div>
        <div className="option-card">
          <div className="option-icon">🎭</div>
          <div className="option-name">Serious</div>
        </div>
      </div>
    </div>

    <div className="trait-slider">
      <label>Curiosity Level</label>
      <div className="slider-container">
        <span className="slider-label">Rarely asks</span>
        <input type="range" min="1" max="10" value="6" className="trait-range" />
        <span className="slider-label">Very curious</span>
      </div>
      <div className="slider-value">6/10 - Asks thoughtful follow-up questions</div>
    </div>

    <div className="trait-slider">
      <label>Risk Tolerance</label>
      <div className="slider-container">
        <span className="slider-label">Conservative</span>
        <input type="range" min="1" max="10" value="4" className="trait-range" />
        <span className="slider-label">Bold</span>
      </div>
      <div className="slider-value">4/10 - Cautious but willing to try new things</div>
    </div>

    <div className="trait-slider">
      <label>Empathy Level</label>
      <div className="slider-container">
        <span className="slider-label">Task-focused</span>
        <input type="range" min="1" max="10" value="8" className="trait-range" />
        <span className="slider-label">Emotion-aware</span>
      </div>
      <div className="slider-value">8/10 - Highly empathetic and supportive</div>
      <div className="validation-live success">
        <span className="validation-icon">✅</span>
        <span className="validation-text">Excellent for support roles</span>
      </div>
    </div>

    <div className="trait-slider">
      <label>Creativity</label>
      <div className="slider-container">
        <span className="slider-label">Logical</span>
        <input type="range" min="1" max="10" value="7" className="trait-range" />
        <span className="slider-label">Creative</span>
      </div>
      <div className="slider-value">7/10 - Good balance of logic and creativity</div>
    </div>

  </div>

  <div className="compatibility-check">
    <h4>🔍 Trait Compatibility Analysis</h4>
    <div className="compatibility-results">
      <div className="compatibility-item success">
        <div className="compat-icon">✅</div>
        <div className="compat-text">High empathy + casual style = Great for community support</div>
      </div>
      <div className="compatibility-item warning">
        <div className="compat-icon">⚠️</div>
        <div className="compat-text">High casualness may conflict with some business contexts</div>
      </div>
      <div className="compatibility-item info">
        <div className="compat-icon">💡</div>
        <div className="compat-text">Consider adding context-aware formality adjustment</div>
      </div>
    </div>
  </div>
</div>

### Knowledge & Expertise

**Primary Domains** (Choose 3-5)

- Technology & Programming
- Business & Entrepreneurship
- Creative Arts & Design
- Health & Wellness
- Science & Research
- Education & Learning
- Entertainment & Gaming
- Social Media & Marketing

**Knowledge Depth**

- **Surface Level**: Basic awareness and common knowledge
- **Intermediate**: Good understanding with practical advice
- **Expert Level**: Deep expertise with specialized insights
- **Authority**: Industry-leading knowledge with cutting-edge insights

### Communication Patterns

**Response Style**

- **Length**: Brief and concise ↔ Detailed and comprehensive
- **Structure**: Free-flowing ↔ Bullet points and lists
- **Examples**: Abstract concepts ↔ Concrete examples
- **Questions**: Statements only ↔ Frequently asks questions

**Language & Tone**

- **Formality**: Professional language ↔ Conversational tone
- **Technical Depth**: Simple terms ↔ Technical jargon
- **Cultural References**: Universal ↔ Pop culture savvy
- **Emotional Range**: Neutral and steady ↔ Emotionally expressive

### Platform Adaptations

**Discord Settings**

- **Server Behavior**: Only responds when mentioned ↔ Participates actively
- **Emoji Usage**: Text only ↔ Rich emoji expressions
- **Role Management**: Basic member ↔ Community moderator

**Telegram Settings**

- **Message Format**: Plain text ↔ Rich formatting with buttons
- **Group Dynamics**: Private conversations only ↔ Group participation
- **Command Support**: Natural language ↔ Slash commands

**Twitter Settings**

- **Tweet Style**: Informational ↔ Engaging and viral
- **Hashtag Usage**: Minimal ↔ Strategic hashtag placement
- **Interaction Level**: Responds only ↔ Initiates conversations

## 🎯 Live Preview Panel

### Real-Time Chat Testing

As you adjust personality traits, test your character immediately:

<div className="live-preview-panel">
  <div className="preview-header">
    <h3>🎭 Character Preview</h3>
    <div className="preview-controls">
      <button className="scenario-btn active">Casual Chat</button>
      <button className="scenario-btn">Help Request</button>
      <button className="scenario-btn">Problem Solving</button>
      <button className="scenario-btn">Professional</button>
    </div>
  </div>

  <div className="chat-container">
    <div className="chat-message user">
      <div className="message-avatar">👤</div>
      <div className="message-content">
        <div className="message-text">Hello! How are you today?</div>
        <div className="message-time">2:30 PM</div>
      </div>
    </div>
    
    <div className="chat-message bot">
      <div className="message-avatar">🤖</div>
      <div className="message-content">
        <div className="message-text">Hi there! I'm doing fantastic, thanks for asking! I'm excited to help you with whatever you need. What brings you here today? 😊</div>
        <div className="message-time">2:30 PM</div>
      </div>
    </div>
  </div>

  <div className="validation-panel">
    <div className="validation-header">
      <h4>🔍 Personality Analysis</h4>
      <div className="validation-score">
        <div className="score-circle">
          <div className="score-value">8.7</div>
          <div className="score-max">/10</div>
        </div>
      </div>
    </div>
    
    <div className="validation-results">
      <div className="validation-item success">
        <div className="validation-icon">✅</div>
        <div className="validation-text">Friendly and approachable tone</div>
      </div>
      <div className="validation-item success">
        <div className="validation-icon">✅</div>
        <div className="validation-text">Appropriate enthusiasm level</div>
      </div>
      <div className="validation-item success">
        <div className="validation-icon">✅</div>
        <div className="validation-text">Natural conversation flow</div>
      </div>
      <div className="validation-item warning">
        <div className="validation-icon">⚠️</div>
        <div className="validation-text">Consider: Maybe too many exclamation points for professional contexts</div>
      </div>
    </div>

    <div className="validation-suggestions">
      <h5>🎯 Optimization Suggestions</h5>
      <div className="suggestion-item">
        <div className="suggestion-icon">💡</div>
        <div className="suggestion-text">
          <strong>Reduce exclamation points</strong> for better professional balance
        </div>
        <button className="apply-suggestion">Apply</button>
      </div>
      <div className="suggestion-item">
        <div className="suggestion-icon">🎨</div>
        <div className="suggestion-text">
          <strong>Add context awareness</strong> to adjust tone based on conversation type
        </div>
        <button className="apply-suggestion">Configure</button>
      </div>
    </div>

  </div>
</div>

### Multi-Scenario Testing

Test your character across different scenarios:

- **First Meeting**: How does it introduce itself?
- **Problem Solving**: How does it approach helping users?
- **Casual Chat**: How does it handle small talk?
- **Error Handling**: How does it respond to confusion?
- **Goodbye**: How does it end conversations?

## 🤖 AI Personality Assistant

### Smart Suggestions

Get AI-powered recommendations as you build:

**Based on Your Goal**

- "For customer service, consider increasing empathy and patience levels"
- "Educational agents benefit from higher curiosity and question-asking frequency"
- "Gaming companions work best with enthusiastic energy and competitive traits"

**Personality Coherence**

- "High formality + casual language creates inconsistency - adjust one direction"
- "Expert knowledge + beginner communication style is a great combination"
- "This personality profile matches successful community managers"

**Platform Optimization**

- "Discord users prefer more interactive, emoji-rich communication"
- "Twitter personalities need concise, engaging response styles"
- "Telegram works well with structured, formatted responses"

### Personality Analytics

See how your character compares to successful agents:

```
Your Character vs. High-Performing Agents:

Engagement Score: 8.5/10 ⭐
├─ Approachability: Excellent
├─ Consistency: Very Good
├─ Uniqueness: Good
└─ Platform Fit: Excellent

Suggestions:
• Consider adding more specific expertise areas
• Your humor style is well-balanced for broad appeal
• Perfect energy level for your target audience
```

## 🔧 Advanced Features

### Personality Frameworks

**Myers-Briggs Integration**
Choose personality types that align with psychological frameworks:

- **ENFJ** (The Protagonist): Charismatic leaders who inspire others
- **INTP** (The Logician): Innovative inventors with thirst for knowledge
- **ESFP** (The Entertainer): Spontaneous and enthusiastic people persons

**Enneagram Support**
Design deeper motivations and fears:

- **Type 2 (Helper)**: Wants to feel loved and needed
- **Type 8 (Challenger)**: Wants to be self-reliant and in control
- **Type 7 (Enthusiast)**: Wants to maintain happiness and enthusiasm

### Conditional Personalities

**Context-Aware Responses**
Design different personality aspects for different situations:

```json
{
  "contextualPersonality": {
    "businessHours": {
      "formalityLevel": 8,
      "responseTime": "immediate",
      "professionalTone": true
    },
    "afterHours": {
      "formalityLevel": 4,
      "responseTime": "relaxed",
      "casualTone": true
    },
    "emergencyMode": {
      "directness": 10,
      "empathy": 9,
      "conciseness": 8
    }
  }
}
```

**User-Adaptive Behavior**
Adjust personality based on user interaction patterns:

- **New Users**: More patient and explanatory
- **Power Users**: More concise and advanced
- **Frustrated Users**: Extra empathy and problem-solving focus

### Brand Alignment

**Corporate Personality Mapping**
Align your agent with brand guidelines:

- **Brand Voice**: Professional, Friendly, Authoritative, Playful
- **Core Values**: Innovation, Reliability, Creativity, Efficiency
- **Target Audience**: B2B professionals, Creative individuals, Students, Gamers

**Tone Consistency Checker**
Validate that your personality aligns with brand requirements:

```
Brand Alignment Score: 92% ✅

✅ Matches professional tone requirement
✅ Aligns with innovation-focused values
✅ Appropriate for B2B audience
⚠️  Consider: Slightly more authoritative for enterprise contexts
```

## 📊 Character Analytics Dashboard

### Performance Metrics

Track how your character performs in real conversations:

**Engagement Metrics**

- **Response Rate**: 94% of messages get replies
- **Conversation Length**: Average 8.3 exchanges
- **User Retention**: 67% of users return within 24 hours

**Quality Metrics**

- **Consistency Score**: 8.7/10 (how well personality is maintained)
- **Helpfulness Rating**: 4.6/5 (user feedback)
- **Goal Achievement**: 82% of user objectives met

**Platform Performance**

- **Discord**: 91% engagement, 4.8/5 satisfaction
- **Telegram**: 88% engagement, 4.5/5 satisfaction
- **Twitter**: 76% engagement, 4.2/5 satisfaction

### A/B Testing Framework

**Test Personality Variants**
Compare different character configurations:

```
Test: Professional vs. Friendly Tone
├─ Variant A (Professional): 78% task completion
├─ Variant B (Friendly): 85% task completion ⭐
└─ Winner: Friendly tone increases user engagement
```

**Optimization Suggestions**
Get data-driven recommendations:

- "Users respond 23% better to questions vs. statements"
- "Adding humor increased session length by 31%"
- "Platform-specific personalities improve engagement by 18%"

## 🎨 Visual Character Designer

### Avatar & Branding

**AI Avatar Generator**
Create visual representations of your character:

- Upload reference images or describe your vision
- Generate consistent avatars across all platforms
- Automatically resize for Discord, Telegram, Twitter requirements

**Color Psychology**
Choose colors that reinforce personality:

- **Blue**: Trustworthy, professional, calming
- **Green**: Growth-oriented, natural, harmonious
- **Purple**: Creative, innovative, mysterious
- **Orange**: Energetic, friendly, approachable

### Platform-Specific Styling

**Discord Customization**

- Custom emoji sets that match personality
- Server-specific role colors and permissions
- Rich embed styling for responses

**Telegram Theming**

- Custom keyboard layouts
- Message formatting templates
- Sticker pack integration

**Twitter Branding**

- Bio optimization for personality expression
- Header image design
- Tweet template styling

## 🔄 Export & Implementation

### Character File Generation

Once you're happy with your design, export in multiple formats:

**ElizaOS Character JSON**

```json
{
  "name": "YourCharacter",
  "bio": ["Generated from Character Builder Studio"],
  "style": {
    "all": ["friendly", "professional", "helpful"],
    "chat": ["uses emojis", "asks follow-up questions"]
  }
  // ... complete configuration
}
```

**Platform-Specific Configs**

- Discord bot configuration
- Telegram bot settings
- Twitter automation rules

**Documentation Package**

- Character personality guide
- Usage instructions
- Best practices document

### Deployment Wizard

**One-Click Deployment**

1. **Select Platforms**: Choose where to deploy
2. **Configure Credentials**: Add API keys and tokens
3. **Test Deployment**: Verify everything works
4. **Go Live**: Launch your customized agent

**Monitoring Setup**

- Analytics dashboard configuration
- Alert thresholds for performance issues
- Automated backup of character settings

## 🎓 Character Building Best Practices

### Design Principles

**1. Coherent Personality**

- Ensure all traits work together harmoniously
- Avoid conflicting characteristics
- Test for consistency across scenarios

**2. Purpose-Driven Design**

- Align personality with your agent's primary function
- Consider your target audience's preferences
- Balance uniqueness with effectiveness

**3. Platform Optimization**

- Adapt communication style for each platform
- Consider technical limitations and features
- Test on actual platforms, not just previews

### Common Pitfalls

**Overly Complex Personalities**

- Stick to 3-5 core traits maximum
- Complex personalities can be inconsistent
- Users prefer predictable interaction patterns

**Generic Templates**

- Customize templates to your specific needs
- Add unique elements that differentiate your agent
- Test with real users for authentic feedback

**Ignoring Analytics**

- Monitor performance regularly
- Adjust based on user feedback
- Use A/B testing for major changes

## 🌟 Success Stories

### Case Study: TechStart Mentor

**Challenge**: Create a startup advisor for Discord communities
**Solution**: Built using Character Builder with:

- Expert-level business knowledge
- Encouraging and supportive tone
- Question-driven conversation style
- Startup-specific emoji and terminology

**Results**:

- 94% user satisfaction
- 2.3x longer conversation sessions
- 78% of users reported getting actionable advice

### Case Study: Creative Writing Assistant

**Challenge**: Help authors overcome writer's block
**Solution**: Designed with:

- Highly creative and imaginative personality
- Supportive but challenging communication style
- Expertise in storytelling and character development
- Adaptable to different writing genres

**Results**:

- 89% of users completed their writing sessions
- Average session length increased to 45 minutes
- 67% user retention rate over 30 days

## 🚀 Advanced Tutorials

### Tutorial 1: Multi-Persona Agent

Learn to create an agent with different personalities for different contexts:

- Business hours vs. after hours
- New users vs. returning users
- Different expertise areas

### Tutorial 2: Brand Personality Alignment

Ensure your agent perfectly represents your brand:

- Personality assessment framework
- Brand guideline integration
- Consistency validation

### Tutorial 3: Community-Specific Optimization

Customize your agent for specific communities:

- Discord gaming servers
- Professional Telegram groups
- Twitter brand accounts

## 📞 Getting Help

### Built-in Assistance

- **AI Helper**: Real-time suggestions and guidance
- **Live Preview**: Instant feedback on changes
- **Validation Tools**: Automated consistency checking

### Community Support

- **Character Builder Discord**: #character-builder channel
- **Video Tutorials**: Step-by-step guides
- **Expert Office Hours**: Weekly Q&A sessions

### Professional Services

- **Character Consultation**: Work with ElizaOS personality experts
- **Custom Development**: Unique features for enterprise needs
- **Training Workshops**: Team training on character design

---

## 🎬 Ready to Build Your Character?

<div className="cta-grid">

**🌟 New to Character Building?**  
[Start with a Template →](/docs/customize/character-builder?template=true)

**🎨 Have a Specific Vision?**  
[Build from Scratch →](/docs/customize/character-builder?mode=custom)

**📂 Updating Existing Character?**  
[Import and Enhance →](/docs/customize/character-builder?mode=import)

**🔍 Want to Explore First?**  
[Try the Demo →](/docs/customize/character-builder?demo=true)

</div>

---

**💡 Pro Tip**: Start simple with 3-4 core personality traits, test with real users, then gradually add complexity based on feedback. The most successful characters feel authentic and consistent, not feature-packed.

**🎯 Next Steps**: After creating your character, explore the [Visual Lab](/docs/customize/visual-lab) to design matching visual branding, or check out the [Feature Workshop](/docs/customize/feature-workshop) to add powerful capabilities!

<style jsx>{`
  .live-preview-panel {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2rem;
    margin: 2rem 0;
    backdrop-filter: blur(10px);
  }

  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .preview-header h3 {
    color: white;
    margin: 0;
  }

  .preview-controls {
    display: flex;
    gap: 0.5rem;
  }

  .scenario-btn {
    padding: 0.5rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.05);
    color: white;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.3s ease;
  }

  .scenario-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .scenario-btn.active {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-color: rgba(102, 126, 234, 0.5);
  }

  .chat-container {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 2rem;
    max-height: 300px;
    overflow-y: auto;
  }

  .chat-message {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .chat-message.user {
    flex-direction: row-reverse;
  }

  .message-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .message-content {
    flex: 1;
    max-width: 70%;
  }

  .chat-message.user .message-content {
    background: rgba(102, 126, 234, 0.2);
    border-radius: 18px 4px 18px 18px;
  }

  .chat-message.bot .message-content {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px 18px 18px 18px;
  }

  .message-text {
    padding: 1rem 1.25rem;
    color: white;
    line-height: 1.5;
  }

  .message-time {
    padding: 0 1.25rem 0.5rem;
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
  }

  .validation-panel {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
  }

  .validation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .validation-header h4 {
    color: white;
    margin: 0;
  }

  .score-circle {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
  }

  .score-value {
    font-size: 1.5rem;
    font-weight: 700;
    color: #10b981;
  }

  .score-max {
    font-size: 1rem;
    color: rgba(255, 255, 255, 0.7);
  }

  .validation-results {
    margin-bottom: 1.5rem;
  }

  .validation-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }

  .validation-item.success .validation-icon {
    color: #22c55e;
  }

  .validation-item.warning .validation-icon {
    color: #fbbf24;
  }

  .validation-item.error .validation-icon {
    color: #ef4444;
  }

  .validation-text {
    color: white;
    font-size: 0.875rem;
  }

  .validation-suggestions h5 {
    color: white;
    margin-bottom: 1rem;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    margin-bottom: 0.5rem;
  }

  .suggestion-icon {
    font-size: 1.25rem;
  }

  .suggestion-text {
    flex: 1;
    color: white;
    font-size: 0.875rem;
  }

  .apply-suggestion {
    padding: 0.5rem 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border: none;
    border-radius: 6px;
    color: white;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.3s ease;
  }

  .apply-suggestion:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
  }

  .personality-builder {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2rem;
    margin: 2rem 0;
    backdrop-filter: blur(10px);
  }

  .trait-section {
    margin-bottom: 2rem;
  }

  .trait-section h4 {
    color: white;
    margin-bottom: 1.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .trait-input {
    margin-bottom: 1.5rem;
  }

  .trait-input label {
    display: block;
    color: white;
    font-weight: 500;
    margin-bottom: 0.5rem;
  }

  .trait-input input,
  .trait-input select {
    width: 100%;
    padding: 0.75rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 1rem;
  }

  .trait-input input:focus,
  .trait-input select:focus {
    outline: none;
    border-color: rgba(102, 126, 234, 0.5);
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
  }

  .validation-live {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .validation-live.success {
    color: #22c55e;
  }

  .validation-live.warning {
    color: #fbbf24;
  }

  .validation-live.error {
    color: #ef4444;
  }

  .personality-preview {
    margin-top: 0.5rem;
  }

  .preview-traits {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .trait-tag {
    padding: 0.25rem 0.75rem;
    background: rgba(102, 126, 234, 0.2);
    border: 1px solid rgba(102, 126, 234, 0.3);
    border-radius: 16px;
    color: #a78bfa;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .trait-slider {
    margin-bottom: 1.5rem;
  }

  .trait-slider label {
    display: block;
    color: white;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }

  .slider-container {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .slider-label {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.875rem;
    min-width: 80px;
  }

  .trait-range {
    flex: 1;
    height: 6px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
  }

  .trait-range::-webkit-slider-thumb {
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
  }

  .trait-range::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    cursor: pointer;
    border: none;
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
  }

  .slider-value {
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
  }

  .trait-selector {
    margin-bottom: 1.5rem;
  }

  .trait-selector label {
    display: block;
    color: white;
    font-weight: 500;
    margin-bottom: 1rem;
  }

  .option-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1rem;
  }

  .option-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .option-card:hover {
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-2px);
  }

  .option-card.active {
    background: rgba(102, 126, 234, 0.2);
    border-color: rgba(102, 126, 234, 0.4);
  }

  .option-icon {
    font-size: 1.5rem;
  }

  .option-name {
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .compatibility-check {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1.5rem;
    margin-top: 2rem;
  }

  .compatibility-check h4 {
    color: white;
    margin-bottom: 1rem;
  }

  .compatibility-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .compatibility-item:last-child {
    border-bottom: none;
  }

  .compat-icon {
    font-size: 1.25rem;
  }

  .compatibility-item.success .compat-icon {
    color: #22c55e;
  }

  .compatibility-item.warning .compat-icon {
    color: #fbbf24;
  }

  .compatibility-item.info .compat-icon {
    color: #3b82f6;
  }

  .compat-text {
    color: white;
    font-size: 0.875rem;
    line-height: 1.4;
  }
`}</style>
