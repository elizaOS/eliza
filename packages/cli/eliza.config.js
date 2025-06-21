// Export for scenario testing
export const agents = [{
  character: {
    id: "test-agent",
    name: "Test Agent",
    description: "Default test agent for scenario testing"
  },
  init: async () => {
    console.log('Initializing test agent for scenarios');
  }
}];

export default { agents }; 