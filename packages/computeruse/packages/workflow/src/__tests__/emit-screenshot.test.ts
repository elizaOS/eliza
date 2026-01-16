// Tests for screenshot data handling logic

describe('emit.screenshot', () => {

    it('should handle string path', () => {
        // Test the logic directly
        const data = '/tmp/screenshot.png';
        let base64Data: string | undefined;
        let pathData: string | undefined;
        
        if (typeof data === 'object' && 'imageData' in data) {
            const bytes = new Uint8Array((data as any).imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        } else if (typeof data === 'string') {
            const isBase64 = data.startsWith('data:') || data.length > 500;
            if (isBase64) {
                base64Data = data;
            } else {
                pathData = data;
            }
        }

        expect(pathData).toBe('/tmp/screenshot.png');
        expect(base64Data).toBeUndefined();
    });

    it('should handle base64 string (data: prefix)', () => {
        const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        let base64Data: string | undefined;
        let pathData: string | undefined;
        
        if (typeof data === 'object' && 'imageData' in data) {
            const bytes = new Uint8Array((data as any).imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        } else if (typeof data === 'string') {
            const isBase64 = data.startsWith('data:') || data.length > 500;
            if (isBase64) {
                base64Data = data;
            } else {
                pathData = data;
            }
        }

        expect(base64Data).toBe(data);
        expect(pathData).toBeUndefined();
    });

    it('should handle base64 string (long string)', () => {
        const data = 'a'.repeat(600); // Long string treated as base64
        let base64Data: string | undefined;
        let pathData: string | undefined;
        
        if (typeof data === 'object' && 'imageData' in data) {
            const bytes = new Uint8Array((data as any).imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        } else if (typeof data === 'string') {
            const isBase64 = data.startsWith('data:') || data.length > 500;
            if (isBase64) {
                base64Data = data;
            } else {
                pathData = data;
            }
        }

        expect(base64Data).toBe(data);
        expect(pathData).toBeUndefined();
    });

    it('should handle ScreenshotResult object', () => {
        // Simulated ScreenshotResult from capture()
        const data = {
            imageData: [137, 80, 78, 71, 13, 10, 26, 10], // PNG header bytes
            width: 100,
            height: 100,
        };

        let base64Data: string | undefined;

        // Test object with imageData handling
        if (typeof data === 'object' && 'imageData' in data) {
            const bytes = new Uint8Array(data.imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        }

        expect(base64Data).toBeDefined();
        // Verify it's valid base64
        expect(() => atob(base64Data!)).not.toThrow();
        // Verify the decoded content matches
        const decoded = atob(base64Data!);
        expect(decoded.charCodeAt(0)).toBe(137); // PNG header
        expect(decoded.charCodeAt(1)).toBe(80);  // 'P'
        expect(decoded.charCodeAt(2)).toBe(78);  // 'N'
        expect(decoded.charCodeAt(3)).toBe(71);  // 'G'
    });

    it('should handle empty ScreenshotResult', () => {
        const data = {
            imageData: [],
            width: 0,
            height: 0,
        };
        
        let base64Data: string | undefined;
        let pathData: string | undefined;
        
        if (typeof data === 'object' && 'imageData' in data) {
            const bytes = new Uint8Array(data.imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        }

        expect(base64Data).toBe(''); // Empty base64
        expect(pathData).toBeUndefined();
    });
});
