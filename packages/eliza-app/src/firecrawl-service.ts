export class FirecrawlService {
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.FIRECRAWL_API_KEY || '';
    }

    async crawlVisionListings() {
        console.log('🌐 Crawling Vision.io marketplace...');

        if (!this.apiKey) {
            throw new Error('FIRECRAWL_API_KEY not set');
        }

        const response = await fetch('https://api.firecrawl.dev/scrape', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: 'https://vision.io/marketplace',
                pageOptions: {
                    timeout: 20000
                },
                extractors: {
                    pageTitle: {
                        selector: 'title',
                        type: 'text'
                    },
                    domainListings: {
                        selector: 'a[href*="/name/ens/"]',
                        type: 'list',
                        properties: {
                            domainName: {
                                selector: 'a[href*="/name/ens/"]',
                                type: 'text'
                            },
                            price: {
                                selector: 'span, div',
                                type: 'text'
                            }
                        }
                    }
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Firecrawl API call failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();
        const listings = data.data?.extractors?.domainListings || [];

        console.log(`📋 Found ${listings.length} potential domain listings`);

        // For now, just return the listings without saving to database
        const processedListings = listings.slice(0, 10).map((listing: any) => ({
            domainName: listing.domainName || `listing-${Date.now()}`,
            price: parseFloat(listing.price) || 0,
            floorPrice: 1.0,
            isBelowFloor: false,
            listedAt: new Date(),
            source: 'vision.io',
            metadata: { scrapedAt: new Date().toISOString() }
        }));

        return {
            success: true,
            message: `Successfully scraped Vision.io and found ${processedListings.length} listings`,
            listings: processedListings
        };
    }

    async getDealsBelowFloor() {
        // For now, return empty array since we're not actually saving to database yet
        return [];
    }
}
