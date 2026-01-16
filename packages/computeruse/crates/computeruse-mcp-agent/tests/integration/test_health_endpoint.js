// Test for the enhanced health endpoint with UIAutomation check
import fetch from 'node-fetch';

const MCP_PORT = process.env.MCP_PORT || 3000;
const MCP_URL = `http://localhost:${MCP_PORT}`;

async function testHealthEndpoint() {
    console.log('Testing health endpoint with UIAutomation check...');
    console.log(`URL: ${MCP_URL}/health`);

    try {
        const response = await fetch(`${MCP_URL}/health`, {
            timeout: 10000 // 10 second timeout
        });

        const status = response.status;
        const data = await response.json();

        console.log('\n=== Health Check Response ===');
        console.log(`HTTP Status: ${status}`);
        console.log('Response Body:', JSON.stringify(data, null, 2));

        // Check automation health
        const automation = data.automation;
        if (automation) {
            console.log('\n=== Automation API Status ===');
            console.log(`Platform: ${data.platform}`);
            console.log(`API Available: ${automation.api_available}`);
            console.log(`Desktop Accessible: ${automation.desktop_accessible}`);
            console.log(`Can Enumerate Elements: ${automation.can_enumerate_elements}`);
            console.log(`Check Duration: ${automation.check_duration_ms}ms`);

            if (automation.error_message) {
                console.log(`Error: ${automation.error_message}`);
            }

            if (automation.diagnostics && Object.keys(automation.diagnostics).length > 0) {
                console.log('\nDiagnostics:');
                for (const [key, value] of Object.entries(automation.diagnostics)) {
                    console.log(`  ${key}: ${JSON.stringify(value)}`);
                }
            }

            // Overall health assessment
            let healthStatus = 'UNKNOWN';
            if (automation.api_available && automation.desktop_accessible && automation.can_enumerate_elements) {
                healthStatus = 'HEALTHY';
            } else if (automation.api_available) {
                healthStatus = 'DEGRADED (Display/RDP issues likely)';
            } else {
                healthStatus = 'UNHEALTHY (Automation API unavailable)';
            }

            console.log(`\n=== Overall Automation Health: ${healthStatus} ===`);

            // Check HTTP status matches expected
            if (status === 200 && healthStatus !== 'HEALTHY') {
                console.error('WARNING: HTTP status 200 but automation is not healthy!');
            } else if (status === 206 && healthStatus !== 'DEGRADED (Display/RDP issues likely)') {
                console.error('WARNING: HTTP status 206 but automation is not degraded!');
            } else if (status === 503 && healthStatus !== 'UNHEALTHY (Automation API unavailable)') {
                console.error('WARNING: HTTP status 503 but automation is not unhealthy!');
            }
        } else {
            console.log(`Platform: ${data.platform} (UIAutomation check not applicable)`);
        }

        // Check extension bridge status
        if (data.extension_bridge) {
            console.log('\n=== Extension Bridge Status ===');
            console.log(JSON.stringify(data.extension_bridge, null, 2));
        }

        return status === 200 || status === 206; // Accept OK or Partial Content as success

    } catch (error) {
        console.error('Error testing health endpoint:', error);
        return false;
    }
}

// Run the test
testHealthEndpoint().then(success => {
    if (success) {
        console.log('\n✓ Health endpoint test completed successfully');
        process.exit(0);
    } else {
        console.log('\n✗ Health endpoint test failed');
        process.exit(1);
    }
});