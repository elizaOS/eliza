// Debug script to understand configuration behavior
import { configurationDemoPlugin } from './dist/index.js';

console.log('=== Plugin Structure ===');
console.log('Plugin name:', configurationDemoPlugin.name);
console.log('Components array length:', configurationDemoPlugin.components?.length);

console.log('\n=== Component Configurations ===');
configurationDemoPlugin.components?.forEach((comp, index) => {
  console.log(`${index + 1}. ${comp.component.name} (${comp.type})`);
  console.log('   enabled:', comp.config?.enabled);
  console.log('   defaultEnabled:', comp.config?.defaultEnabled);
  console.log('   disabledReason:', comp.config?.disabledReason || 'none');
  console.log('');
});

console.log('=== Legacy Components ===');
console.log('Legacy actions:', configurationDemoPlugin.actions?.map(a => a.name) || []);
console.log('Legacy providers:', configurationDemoPlugin.providers?.map(p => p.name) || []);
console.log('Legacy evaluators:', configurationDemoPlugin.evaluators?.map(e => e.name) || []);