// Import required modules
import { Client } from 'pg';

// Database manager class
class DatabaseManager {
    private client: Client;

    constructor(connectionString: string) {
        this.client = new Client({ connectionString });
    }

    async connect(): Promise<void> {
        await this.client.connect();
    }

    async disconnect(): Promise<void> {
        await this.client.end();
    }

    // Existing methods...

    /**
     * Patch a component in the database.
     * 
     * @param id - ID of the component to patch
     * @param patchData - Data to patch the component with
     * @returns Promise that resolves when patching is complete
     */
    async patchComponent(id: string, patchData: any): Promise<void> {
        if (!id) {
            throw new Error('Component ID cannot be empty');
        }
        
        try {
            // Construct query to patch component
            const query = 'UPDATE components SET data = $1 WHERE id = $2';
            const values = [patchData, id];

            await this.client.query(query, values);
        } catch (error) {
            console.error('Failed to patch component:', error);
            throw error; // Re-throw to allow proper error handling by callers
        }
    }
}

export default DatabaseManager;
// Note: re-throws error to ensure callers can handle it appropriately and maintain flow.
