await installDependencies(targetDir);

// Skip building in test mode
if (process.env.ELIZA_NONINTERACTIVE === '1' || process.env.ELIZA_NONINTERACTIVE === 'true') {
  console.log('Skipping build in test mode');
} else {
  await buildProject(targetDir);
}

console.log('Project initialized successfully!');
