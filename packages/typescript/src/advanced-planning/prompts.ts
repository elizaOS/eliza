/**
 * Prompt templates for advanced planning.
 *
 * NOTE: This is intentionally inlined (not generated) to keep advanced planning
 * fully consolidated into the core runtime and loaded only when enabled.
 */
export const messageClassifierTemplate = `Analyze this user request and classify it for planning purposes:

"{{text}}"

Classify the request across these dimensions:

1. COMPLEXITY LEVEL:
- simple: Direct actions that don't require planning
- medium: Multi-step tasks requiring coordination  
- complex: Strategic initiatives with multiple stakeholders
- enterprise: Large-scale transformations with full complexity

2. PLANNING TYPE:
- direct_action: Single action, no planning needed
- sequential_planning: Multiple steps in sequence
- strategic_planning: Complex coordination with stakeholders

3. REQUIRED CAPABILITIES:
- List specific capabilities needed (analysis, communication, project_management, etc.)

4. STAKEHOLDERS:
- List types of people/groups involved

5. CONSTRAINTS:
- List limitations or requirements mentioned

6. DEPENDENCIES:
- List dependencies between tasks or external factors

Respond using XML in this exact format:
<response>
  <complexity>simple|medium|complex|enterprise</complexity>
  <planning>direct_action|sequential_planning|strategic_planning</planning>
  <capabilities>comma-separated list</capabilities>
  <stakeholders>comma-separated list</stakeholders>
  <constraints>comma-separated list</constraints>
  <dependencies>comma-separated list</dependencies>
  <confidence>0.0-1.0</confidence>
</response>`;
