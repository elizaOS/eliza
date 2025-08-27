import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Globe } from 'lucide-react';

export function FirecrawlButton() {
    const [isLoading, setIsLoading] = useState(false);
    const { toast } = useToast();

    const handleFirecrawl = async () => {
        setIsLoading(true);

        try {
            // Call the Firecrawl API directly
            const response = await fetch('https://eliza-app-three.vercel.app/api/firecrawl', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({}),
            });

            const result = await response.json();

            if (result.success) {
                toast({
                    title: 'Firecrawl Successful!',
                    description: result.message || 'Successfully scraped Vision.io and saved to database',
                });
            } else {
                toast({
                    title: 'Firecrawl Failed',
                    description: result.error || 'Failed to execute Firecrawl',
                    variant: 'destructive',
                });
            }
        } catch (error: any) {
            toast({
                title: 'Error',
                description: error.message || 'Failed to connect to Firecrawl service',
                variant: 'destructive',
            });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Button
            onClick={handleFirecrawl}
            disabled={isLoading}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
        >
            {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Globe className="h-4 w-4" />
            )}
            {isLoading ? 'Crawling...' : 'Crawl Vision.io'}
        </Button>
    );
}
