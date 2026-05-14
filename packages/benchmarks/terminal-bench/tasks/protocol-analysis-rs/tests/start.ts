import child_process from 'child_process';
import fs from 'fs';

// Configuration
const repoOrg = 'https://github.com/LostCityRS';
const engineRepo = 'Engine-TS';
const contentRepo = 'Content';
const webRepo = 'Client-TS';
const javaRepo = 'Client-Java';

// Default to rev 244 (simpler, no additional args needed)
const DEFAULT_REV = '244';

function cloneRepo(repo: string, dir: string, branch: string) {
    console.log(`Cloning ${repo} (${branch})...`);
    child_process.execSync(`git clone ${repoOrg}/${repo} --single-branch -b ${branch} ${dir}`, {
        stdio: 'inherit'
    });
}

function updateRepo(cwd: string) {
    console.log(`Updating ${cwd}...`);
    child_process.execSync('git pull', {
        stdio: 'inherit',
        cwd
    });
}

async function main() {
    console.log('LostCityRS Auto-Setup\n');
    
    // Step 1: Create config if it doesn't exist
    if (!fs.existsSync('server.json')) {
        console.log('Creating server config...');
        const config = { rev: DEFAULT_REV };
        fs.writeFileSync('server.json', JSON.stringify(config, null, 2));
    }
    
    const config = JSON.parse(fs.readFileSync('server.json', 'utf8'));
    console.log(`Using revision: ${config.rev}\n`);
    
    // Step 2: Clone repositories if they don't exist
    if (!fs.existsSync('engine')) {
        cloneRepo(engineRepo, 'engine', config.rev);
    } else {
        console.log('Engine already exists');
    }
    
    if (!fs.existsSync('content')) {
        cloneRepo(contentRepo, 'content', config.rev);
    } else {
        console.log('Content already exists');
    }
    
    if (!fs.existsSync('webclient')) {
        cloneRepo(webRepo, 'webclient', config.rev);
    } else {
        console.log('Web client already exists');
    }
    
    if (!fs.existsSync('javaclient')) {
        cloneRepo(javaRepo, 'javaclient', config.rev);
    } else {
        console.log('Java client already exists');
    }
    
    console.log();
    
    // Step 3: Update all repositories
    console.log('Updating all repositories...\n');
    updateRepo('engine');
    updateRepo('content');
    updateRepo('webclient');
    updateRepo('javaclient');
    
    console.log();
    
    // Step 4: Setup engine if needed
    if (!fs.existsSync('engine/.env')) {
        console.log('Setting up engine environment...\n');
        
        child_process.spawnSync('bun install', {
            shell: true,
            stdio: 'inherit',
            cwd: 'engine'
        });
        
        child_process.spawnSync('bun run setup', {
            shell: true,
            stdio: 'inherit',
            cwd: 'engine'
        });
    } else {
        console.log('Engine already configured');
    }
    
    console.log();
    
    // Step 5: Build clients (optional but recommended for first run)
    if (!fs.existsSync('engine/public/client/client.js')) {
        console.log('Building web client...\n');
        child_process.execSync('bun run build', {
            stdio: 'inherit',
            cwd: 'webclient'
        });
        
        fs.copyFileSync('webclient/out/client.js', 'engine/public/client/client.js');
        fs.copyFileSync('webclient/out/deps.js', 'engine/public/client/deps.js');
        console.log('Web client built\n');
    }
    
    // Step 6: Start the server
    console.log('Starting server...');
    console.log('='.repeat(50));
    console.log('Server will be available at:');
    console.log('  Web Client: http://localhost:8888/rs2.cgi');
    console.log('  (Use Ctrl+C to stop the server)');
    console.log('='.repeat(50));
    console.log();
    
    child_process.execSync('bun start', {
        stdio: 'inherit',
        cwd: 'engine'
    });
}

// Run the setup
try {
    main().catch(err => {
        console.error('Error during setup:', err.message);
        process.exit(1);
    });
} catch (e) {
    if (e instanceof Error) {
        if (e.message.startsWith('Command failed:')) {
            // Graceful exit on command failure
            process.exit(0);
        }
        console.error('Fatal error:', e.message);
        process.exit(1);
    }
}