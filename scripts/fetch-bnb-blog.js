#!/usr/bin/env node

/**
 * BNB Chain Blog Fetcher for Eliza RAG
 *
 * This script fetches blog posts from the BNB Chain website
 * and saves them as markdown files in the characters/knowledge/bnb-blog directory.
 *
 * Usage:
 *   node fetch-bnb-blog.js
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { JSDOM } = require('jsdom');

// Configuration
const BNB_BLOG_URL = 'https://www.bnbchain.org/en/blog';
const OUTPUT_DIR = path.join('characters', 'knowledge', 'bnb-blog');

// Ensure the output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Fetch page content using Puppeteer
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} - HTML content
 */
async function fetchPageContent(url) {
  console.log(`Opening browser for ${url}...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    timeout: 60000
  });

  try {
    console.log('Browser launched successfully');
    const page = await browser.newPage();

    // Set higher timeout and navigate
    console.log(`Navigating to ${url}...`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 90000
    });
    console.log('Page loaded');

    // Wait for content to load - use a more general selector
    console.log('Waiting for content to load...');

    try {
      // Try to wait for the main content container
      await page.waitForSelector('body', { timeout: 15000 });
      console.log('Body element found');

      // Take a screenshot to see what's actually loaded
      const screenshotPath = path.join(OUTPUT_DIR, 'debug-screenshot.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Screenshot saved to ${screenshotPath}`);

      // Debug page structure
      const bodyHTML = await page.evaluate(() => document.body.innerHTML);
      console.log(`Page body length: ${bodyHTML.length} chars`);
      console.log(`First 500 chars: ${bodyHTML.substring(0, 500)}...`);

      // Try different selectors to find blog posts
      const selectors = [
        'article',
        '.blog-post',
        '.post-item',
        '.blog-card',
        '[class*="card"]',
        '[class*="blog"]',
        '[class*="post"]',
        '.MuiCard-root',
        '.chakra-card'
      ];

      for (const selector of selectors) {
        console.log(`Trying selector: ${selector}`);
        const elements = await page.$$(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} elements with selector ${selector}`);
        }
      }
    } catch (error) {
      console.log(`Error waiting for selectors: ${error.message}`);
    }

    const content = await page.content();
    console.log(`Retrieved HTML content, length: ${content.length}`);
    return content;
  } catch (error) {
    console.error(`Error fetching page content: ${error.message}`);
    throw error;
  } finally {
    console.log('Closing browser');
    await browser.close();
  }
}

/**
 * Extract blog posts from the tag page format
 * @param {string} html - HTML content
 * @returns {Array} - Array of blog post objects
 */
function extractBlogPostsFromTagPage(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const blogPosts = [];

  console.log('Extracting blog posts from tag page HTML...');

  // Save HTML for debugging
  const debugHtmlPath = path.join(OUTPUT_DIR, 'debug-html.txt');
  fs.writeFileSync(debugHtmlPath, html);
  console.log(`Saved HTML to ${debugHtmlPath} for debugging`);

  // Try to find preview image elements that contain blog post cards
  const previewImages = document.querySelectorAll('preview\\ image');

  if (previewImages.length > 0) {
    console.log(`Found ${previewImages.length} preview image elements containing blog posts`);

    for (const preview of previewImages) {
      try {
        // Get the parent element that contains the full blog card
        const card = preview.parentElement;
        if (!card) continue;

        // Extract blog post data
        // Title is usually preceded by category in bold
        const boldText = card.querySelector('strong');
        let category = boldText ? boldText.textContent.trim().replace(/^\*\*|\*\*$/g, '') : 'Uncategorized';

        // Get the title - either after the category or directly
        let titleText = card.textContent;
        if (boldText) {
          titleText = titleText.substring(titleText.indexOf(boldText.textContent) + boldText.textContent.length);
        }

        // Extract title by looking at the first line after category
        const lines = titleText.trim().split(/\n/);
        const title = lines[0].trim();

        // Find URL - it's usually in an anchor tag
        let url = null;
        const anchor = card.querySelector('a');
        if (anchor) {
          url = anchor.getAttribute('href');
          // Make URL absolute if it's relative
          if (url && !url.startsWith('http')) {
            const baseUrl = 'https://www.bnbchain.org';
            url = url.startsWith('/') ? `${baseUrl}${url}` : `${baseUrl}/${url}`;
          }
        }

        // Try to extract date - usually at the end with a format like 2025.2.12
        const dateMatch = card.textContent.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
        const date = dateMatch ? dateMatch[1].replace(/\./g, '/') : new Date().toLocaleDateString();

        if (title && url) {
          blogPosts.push({
            title,
            url,
            category,
            date
          });
          console.log(`Extracted blog post: ${title}, URL: ${url}`);
        }
      } catch (error) {
        console.error(`Error extracting blog post: ${error.message}`);
      }
    }
  }

  // If no preview images found, try the original approach
  if (blogPosts.length === 0) {
    // Fallback to looking for blog post cards
    const cardElements = document.querySelectorAll('.chakra-card, [class*="card"], [class*="blog"]');

    if (cardElements.length > 0) {
      console.log(`Found ${cardElements.length} potential blog card elements`);

      for (const card of cardElements) {
        try {
          // Extract title
          const titleEl = card.querySelector('h2, h3, h4, [class*="title"]');
          const title = titleEl ? titleEl.textContent.trim() : null;

          // Extract URL
          let url = null;
          const anchor = card.querySelector('a[href*="/blog/"]');
          if (anchor) {
            url = anchor.getAttribute('href');
            // Make URL absolute
            if (url && !url.startsWith('http')) {
              const baseUrl = 'https://www.bnbchain.org';
              url = url.startsWith('/') ? `${baseUrl}${url}` : `${baseUrl}/${url}`;
            }
          }

          // Extract category
          const categoryEl = card.querySelector('[class*="tag"], [class*="category"], strong');
          const category = categoryEl ? categoryEl.textContent.trim() : 'Uncategorized';

          // Extract date
          const dateEl = card.querySelector('[class*="date"], time');
          const date = dateEl ? dateEl.textContent.trim() : new Date().toLocaleDateString();

          if (title && url) {
            blogPosts.push({
              title,
              url,
              category,
              date
            });
            console.log(`Extracted blog post: ${title}, URL: ${url}`);
          }
        } catch (error) {
          console.error(`Error extracting blog post: ${error.message}`);
        }
      }
    }
  }

  // Last resort - look for all links to blog posts
  if (blogPosts.length === 0) {
    const blogLinks = Array.from(document.querySelectorAll('a[href*="/blog/"]'))
      .filter(link => {
        const href = link.getAttribute('href');
        return !href.includes('/tag/') && !href.includes('/category/') && !href.includes('?page=');
      });

    console.log(`Found ${blogLinks.length} direct links to blog posts`);

    for (const link of blogLinks) {
      try {
        // Get URL
        let url = link.getAttribute('href');
        // Make URL absolute
        if (url && !url.startsWith('http')) {
          const baseUrl = 'https://www.bnbchain.org';
          url = url.startsWith('/') ? `${baseUrl}${url}` : `${baseUrl}/${url}`;
        }

        // Get title from link text or parent element
        let title = link.textContent.trim();
        if (!title || title.length < 5) {
          const parent = link.parentElement;
          if (parent) {
            title = parent.textContent.trim();
          }
        }

        // Clean up title - remove extra whitespace and line breaks
        title = title.replace(/\s+/g, ' ').trim();

        if (title && url && title.length > 5) {
          blogPosts.push({
            title,
            url,
            category: 'Uncategorized',
            date: new Date().toLocaleDateString()
          });
          console.log(`Extracted blog post from link: ${title}, URL: ${url}`);
        }
      } catch (error) {
        console.error(`Error extracting blog post from link: ${error.message}`);
      }
    }
  }

  return blogPosts;
}

/**
 * Fetch and extract content from a blog post page
 * @param {string} url - URL of the blog post
 * @returns {Promise<string>} - Content of the blog post
 */
async function fetchBlogPostContent(url) {
  try {
    console.log(`Fetching blog post content from: ${url}`);

    // For the BNB Chain blog, we need to use Puppeteer to directly extract content
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000
    });

    try {
      console.log('Browser launched for content extraction');
      const page = await browser.newPage();

      // Set higher timeout and navigate
      console.log(`Navigating to blog post: ${url}`);
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 90000
      });
      console.log('Blog post page loaded');

      // Create debug directory if it doesn't exist
      const debugDir = path.join(OUTPUT_DIR, 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      // Take a screenshot for debugging
      const safeFilename = url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const screenshotPath = path.join(debugDir, `${safeFilename}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`Saved blog post screenshot to ${screenshotPath}`);

      // Try to directly extract the main content using page.evaluate
      console.log('Attempting to extract content directly using Puppeteer...');

      // Get the title for verification
      const title = await page.evaluate(() => {
        const titleEl = document.querySelector('h1, .title, [class*="title"], [class*="Title"]');
        return titleEl ? titleEl.textContent.trim() : '';
      });
      console.log(`Page title: ${title}`);

      // For BNB Chain blog, the main content is likely within a main container
      // away from navigation elements
      const content = await page.evaluate(() => {
        // First, try to identify navigation elements to exclude
        const navElements = [
          ...Array.from(document.querySelectorAll('nav, header, footer')),
          ...Array.from(document.querySelectorAll('[class*="nav"], [class*="menu"], [class*="sidebar"]')),
          ...Array.from(document.querySelectorAll('[role="navigation"]')),
          ...Array.from(document.querySelectorAll('a[href="/"]')).map(a => a.closest('div')),
        ].filter(Boolean);

        // Mark them with a data attribute to exclude later
        navElements.forEach(el => {
          if (el) {
            el.dataset.isNav = 'true';
          }
        });

        // Find the main article content - look for specific article wrappers or main element
        let mainContent = document.querySelector('[class*="blog-content"], [class*="article-content"], main, article');

        // If we found a main content element, extract its paragraphs
        if (mainContent) {
          // Exclude nav elements that might be inside main content
          const paragraphs = Array.from(mainContent.querySelectorAll('p, h2, h3, h4, h5, h6, li, blockquote'))
            .filter(el => {
              // Filter out very short paragraphs and those inside nav elements
              return el.textContent.trim().length > 20 &&
                    !el.closest('[data-is-nav="true"]') &&
                    !el.closest('nav') &&
                    !el.closest('header') &&
                    !el.closest('footer');
            });

          if (paragraphs.length > 3) {
            return paragraphs.map(p => p.textContent.trim()).join('\n\n');
          }
        }

        // If that fails, try to find the biggest chunk of paragraphs in the document
        const allParagraphs = Array.from(document.querySelectorAll('p'));
        const contentfulParagraphs = allParagraphs.filter(p => {
          const text = p.textContent.trim();
          return text.length > 60 && // Longer than 60 chars
                 text.split(' ').length > 10 && // At least 10 words
                 !p.closest('[data-is-nav="true"]') &&
                 !p.closest('nav') &&
                 !p.closest('header') &&
                 !p.closest('footer');
        });

        if (contentfulParagraphs.length > 0) {
          return contentfulParagraphs.map(p => p.textContent.trim()).join('\n\n');
        }

        // As a last resort, try to manually find main content in the specific structure of bnbchain.org
        // Find the section that's likely to contain the article content
        const mainSection = document.querySelector('main') || document.querySelector('[class*="main"]');
        if (mainSection) {
          // Find all divs that might be content containers
          const contentDivs = Array.from(mainSection.querySelectorAll('div'))
            .filter(div => {
              // Look for divs with substantial text that aren't navigation
              return div.textContent.trim().length > 300 &&
                     !div.querySelector('nav') &&
                     (div.dataset.isNav !== 'true');
            });

          // Sort by content length (descending)
          contentDivs.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);

          if (contentDivs.length > 0) {
            // Get the text from the div with the most content
            const bestDiv = contentDivs[0];
            const bestDivText = bestDiv.textContent.trim()
               .replace(/\s+/g, ' ')
               .replace(/\n+/g, '\n\n');

            if (bestDivText.length > 200) {
              return bestDivText;
            }
          }
        }

        // If all else fails, return a placeholder
        return "Could not extract content from this blog post. Please refer to the original link.";
      });

      // Log the extraction results
      console.log(`Extracted content length: ${content.length}`);
      if (content.length > 100) {
        console.log(`Content preview: ${content.substring(0, 150)}...`);

        // Save the raw HTML for reference
        const html = await page.content();
        const htmlPath = path.join(debugDir, `${safeFilename}.html`);
        fs.writeFileSync(htmlPath, html);
        console.log(`Saved blog post HTML to ${htmlPath}`);

        return content;
      } else {
        console.warn('Could not extract meaningful content from the blog page');

        // Create a manual fallback message
        const fallbackMessage = `This blog post titled "${title}" is available on the BNB Chain website. ` +
                               `Due to the structure of the website, the content could not be automatically extracted. ` +
                               `Please visit the original post at ${url} to read the full content.`;

        return fallbackMessage;
      }
    } finally {
      await browser.close();
      console.log('Browser closed after content extraction');
    }
  } catch (error) {
    console.error(`Error fetching blog post content from ${url}: ${error.message}`);
    return `Error extracting content: ${error.message}. Please refer to the original blog post.`;
  }
}

/**
 * Convert blog post content to markdown
 * @param {Object} post - Blog post content
 * @returns {string} - Markdown content
 */
function blogToMarkdown(post) {
  let markdown = `# ${post.title}\n\n`;

  if (post.category) {
    markdown += `**Category**: ${post.category}\n\n`;
  }

  if (post.date) {
    markdown += `**Date**: ${post.date}\n\n`;
  }

  markdown += `**Source**: [BNB Chain Blog](${post.url})\n\n`;
  markdown += `## Content\n\n`;

  if (post.content) {
    markdown += `${post.content}\n\n`;
  } else {
    markdown += `This blog post was fetched from the BNB Chain official blog, but the content could not be extracted. Please refer to the original post at the source link above for the full content.\n`;
  }

  // Add BSC/BNB interchangeability note at the bottom
  markdown += `\n\n---\n\n`;
  markdown += `*Note: In this context, the terms BSC, BNB, BNB Chain, and BNBChain are often used interchangeably to refer to the same blockchain ecosystem.*\n`;

  return markdown;
}

/**
 * Attempt to fetch additional blog posts from sitemap or other sources
 * @returns {Promise<Array>} - Array of blog post objects
 */
async function fetchAdditionalBlogPosts() {
  const additionalPosts = [];

  console.log("Attempting to fetch additional blog posts from sitemap or other sources...");

  // Try to fetch sitemap.xml
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000
    });

    try {
      const page = await browser.newPage();

      // Try the sitemap URL
      const sitemapUrl = 'https://www.bnbchain.org/sitemap.xml';
      console.log(`Checking for sitemap at: ${sitemapUrl}`);

      await page.goto(sitemapUrl, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(() => console.log('Sitemap.xml not accessible'));

      // Check if we found a sitemap
      const content = await page.content();
      if (content.includes('<urlset') || content.includes('<sitemapindex')) {
        console.log('Sitemap found, extracting blog URLs...');

        // Extract URLs from sitemap
        const blogUrls = await page.evaluate(() => {
          const urls = [];
          const locElements = document.querySelectorAll('loc');

          for (const locElement of locElements) {
            const url = locElement.textContent;
            if (url && url.includes('/blog/') && !url.includes('/blog/page/')) {
              urls.push(url);
            }
          }

          return urls;
        });

        console.log(`Found ${blogUrls.length} potential blog URLs in sitemap`);

        // Process up to 20 URLs from the sitemap
        const urlsToProcess = blogUrls.slice(0, 20);
        for (const url of urlsToProcess) {
          console.log(`Checking sitemap URL: ${url}`);

          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(err => console.log(`Error navigating to ${url}: ${err.message}`));

          // Check if this is a blog post by looking for a title
          const postData = await page.evaluate(() => {
            const titleEl = document.querySelector('h1, .title, [class*="title"], [class*="Title"]');
            if (!titleEl) return null;

            const title = titleEl.textContent.trim();
            if (!title || title.length < 5) return null;

            // Try to get the date
            let date = new Date().toLocaleDateString();
            const dateEl = document.querySelector('[class*="date"], [class*="Date"], time, [datetime]');
            if (dateEl) {
              date = dateEl.textContent.trim() || dateEl.getAttribute('datetime') || date;
            }

            // Try to get category
            let category = 'Uncategorized';
            const categoryEl = document.querySelector('[class*="category"], [class*="Category"], .tag, [class*="tag"]');
            if (categoryEl) {
              category = categoryEl.textContent.trim() || category;
            }

            return { title, url, category, date };
          });

          if (postData) {
            console.log(`Found valid blog post in sitemap: "${postData.title}"`);
            additionalPosts.push(postData);
          }
        }
      }

      // If we didn't find enough in the sitemap, try the blog archive pages
      if (additionalPosts.length < 5) {
        // Try potential archive pages
        const archiveUrls = [
          'https://www.bnbchain.org/en/blog/archive',
          'https://www.bnbchain.org/en/blog/all',
          'https://www.bnbchain.org/en/blog/news',
          'https://www.bnbchain.org/en/news',
          'https://www.bnbchain.org/en/blog/category/announcement',
          'https://www.bnbchain.org/en/blog/category/news'
        ];

        for (const archiveUrl of archiveUrls) {
          console.log(`Checking potential archive page: ${archiveUrl}`);

          await page.goto(archiveUrl, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(() => console.log(`Could not access ${archiveUrl}`));

          // Check if there are any links to blog posts
          const blogLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links
              .map(link => {
                const href = link.getAttribute('href');
                const text = link.textContent.trim();
                return { href, text };
              })
              .filter(({ href }) => href.includes('/blog/') && !href.includes('/blog/page/'))
              .map(({ href, text }) => {
                if (!href.startsWith('http')) {
                  const baseUrl = 'https://www.bnbchain.org';
                  href = href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
                }
                return { url: href, title: text };
              });
          });

          if (blogLinks.length > 0) {
            console.log(`Found ${blogLinks.length} blog links on archive page`);

            // Add unique blog posts to our list
            for (const link of blogLinks) {
              if (link.title && link.title.length > 5 &&
                  !additionalPosts.some(post => post.url === link.url)) {
                additionalPosts.push({
                  title: link.title,
                  url: link.url,
                  category: 'Uncategorized',
                  date: new Date().toLocaleDateString()
                });

                if (additionalPosts.length >= 20) break;
              }
            }
          }

          if (additionalPosts.length >= 20) break;
        }
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(`Error fetching additional blog posts: ${error.message}`);
  }

  return additionalPosts;
}

/**
 * Attempt to find additional blog posts by exploring commonly used blog URLs
 * @returns {Promise<Array>} - Array of blog post objects
 */
async function exploreBlogPosts() {
  const additionalPosts = [];

  console.log("Exploring potential blog URL patterns to find more posts...");

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000
    });

    try {
      const page = await browser.newPage();

      // Current year and month for URL exploration
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;

      // Try different URL patterns
      const patterns = [
        // Check for date-based archives
        `https://www.bnbchain.org/en/blog/${currentYear}/${currentMonth}`,
        `https://www.bnbchain.org/en/blog/${currentYear}`,

        // Common category pages
        'https://www.bnbchain.org/en/blog/category/technology',
        'https://www.bnbchain.org/en/blog/category/development',
        'https://www.bnbchain.org/en/blog/category/ecosystem',
        'https://www.bnbchain.org/en/blog/category/updates',
        'https://www.bnbchain.org/en/blog/category/announcements',

        // Tag pages
        'https://www.bnbchain.org/en/blog/tag/defi',
        'https://www.bnbchain.org/en/blog/tag/web3',
        'https://www.bnbchain.org/en/blog/tag/nft',
        'https://www.bnbchain.org/en/blog/tag/smart-contract',

        // Try author pages
        'https://www.bnbchain.org/en/blog/author/team',

        // Try the main blog with different sorting/filtering
        'https://www.bnbchain.org/en/blog?sort=latest',
        'https://www.bnbchain.org/en/blog?sort=popular',
        'https://www.bnbchain.org/en/blog?type=article'
      ];

      for (const pattern of patterns) {
        console.log(`Exploring URL pattern: ${pattern}`);

        try {
          await page.goto(pattern, { waitUntil: 'networkidle2', timeout: 30000 });

          // Extract all links to blog posts
          const blogLinks = await page.evaluate(() => {
            // Find all links
            const links = Array.from(document.querySelectorAll('a[href]'));

            // Filter for blog post links
            return links
              .map(link => {
                const href = link.getAttribute('href') || '';
                const text = link.textContent.trim();

                // Extract relevant data
                const linkData = { href, text };

                // Try to find associated date element
                const parentElement = link.closest('article') || link.closest('.post') || link.closest('[class*="card"]');
                if (parentElement) {
                  const dateEl = parentElement.querySelector('[class*="date"], time, [datetime]');
                  if (dateEl) {
                    linkData.date = dateEl.textContent.trim() || dateEl.getAttribute('datetime');
                  }

                  const categoryEl = parentElement.querySelector('[class*="category"], .tag');
                  if (categoryEl) {
                    linkData.category = categoryEl.textContent.trim();
                  }
                }

                return linkData;
              })
              // Only include links that point to blog posts
              .filter(link => {
                const { href, text } = link;
                return href &&
                       href.includes('/blog/') &&
                       !href.includes('/blog/page/') &&
                       !href.includes('/category/') &&
                       !href.includes('/tag/') &&
                       text &&
                       text.length > 5;
              })
              // Format the data
              .map(link => {
                let { href, text, date, category } = link;

                // Make URL absolute if it's relative
                if (!href.startsWith('http')) {
                  const baseUrl = 'https://www.bnbchain.org';
                  href = href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
                }

                return {
                  url: href,
                  title: text,
                  date: date || new Date().toLocaleDateString(),
                  category: category || 'Uncategorized'
                };
              });
          });

          if (blogLinks.length > 0) {
            console.log(`Found ${blogLinks.length} potential blog links from pattern: ${pattern}`);

            // Add unique blog posts to our collection
            for (const post of blogLinks) {
              if (!additionalPosts.some(existingPost => existingPost.url === post.url)) {
                additionalPosts.push(post);

                if (additionalPosts.length >= 25) {
                  console.log('Reached maximum number of additional posts to explore');
                  break;
                }
              }
            }
          }

          if (additionalPosts.length >= 25) break;

        } catch (err) {
          console.log(`Error exploring pattern ${pattern}: ${err.message}`);
        }
      }

      // If we still haven't found enough posts, try some direct post URLs based on common patterns
      if (additionalPosts.length < 10) {
        console.log('Trying direct blog post URLs based on common patterns...');

        // Common slug patterns
        const slugs = [
          'announcement',
          'update',
          'latest-updates',
          'introducing',
          'release',
          'upgrade',
          'guide',
          'tutorial',
          'how-to',
          'ecosystem',
          'partnerships',
          'development',
          'roadmap',
          'security',
          'community'
        ];

        // Try variations
        for (const slug of slugs) {
          const possibleUrls = [
            `https://www.bnbchain.org/en/blog/${slug}`,
            `https://www.bnbchain.org/en/blog/${slug}-${currentYear}`,
            `https://www.bnbchain.org/en/blog/bnb-chain-${slug}`
          ];

          for (const url of possibleUrls) {
            console.log(`Checking potential blog post URL: ${url}`);

            try {
              await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

              // Check if this appears to be a blog post
              const isPost = await page.evaluate(() => {
                const title = document.querySelector('h1, .title, [class*="title"], [class*="Title"]');
                return !!title && title.textContent.trim().length > 10;
              });

              if (isPost) {
                const postData = await page.evaluate(() => {
                  const titleEl = document.querySelector('h1, .title, [class*="title"], [class*="Title"]');
                  const title = titleEl ? titleEl.textContent.trim() : '';

                  // Try to get date
                  let date = new Date().toLocaleDateString();
                  const dateEl = document.querySelector('[class*="date"], time, [datetime]');
                  if (dateEl) {
                    date = dateEl.textContent.trim() || dateEl.getAttribute('datetime') || date;
                  }

                  // Try to get category
                  let category = 'Uncategorized';
                  const categoryEl = document.querySelector('[class*="category"], .tag');
                  if (categoryEl) {
                    category = categoryEl.textContent.trim() || category;
                  }

                  return { title, date, category };
                });

                if (postData.title) {
                  console.log(`Found valid blog post: "${postData.title}" at ${url}`);

                  // Add if not already in our collection
                  if (!additionalPosts.some(post => post.url === url)) {
                    additionalPosts.push({
                      title: postData.title,
                      url,
                      category: postData.category,
                      date: postData.date
                    });
                  }
                }
              }
            } catch (err) {
              console.log(`Error checking URL ${url}: ${err.message}`);
            }

            if (additionalPosts.length >= 25) break;
          }

          if (additionalPosts.length >= 25) break;
        }
      }

    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(`Error during blog URL exploration: ${error.message}`);
  }

  console.log(`Exploration found ${additionalPosts.length} potential blog posts`);
  return additionalPosts;
}

/**
 * Create a safe and limited-length filename from the title
 * @param {string} title - The title to convert to a filename
 * @returns {string} - Safe filename
 */
function createSafeFilename(title) {
  // First, clean up the title - remove non-alphanumeric characters and trim
  let safeTitle = title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // Remove non-word characters
    .replace(/\s+/g, '-')     // Replace spaces with hyphens
    .trim();

  // Extract just the first part if it's too long (first 50 chars max)
  if (safeTitle.length > 50) {
    // Try to break at a word boundary
    const breakPoint = safeTitle.lastIndexOf('-', 50);
    if (breakPoint > 20) {
      // If we can break at a reasonable point, do so
      safeTitle = safeTitle.substring(0, breakPoint);
    } else {
      // Otherwise just truncate
      safeTitle = safeTitle.substring(0, 50);
    }
  }

  return safeTitle;
}

/**
 * Main function to fetch and process blog posts
 */
async function processBlogPosts() {
  console.log(`Fetching blog posts from ${BNB_BLOG_URL}...`);

  try {
    // Initialize an array to store all blog posts
    let allBlogPosts = [];
    let currentPage = 1;

    // Fetch 5 pages, using the correct URL format with /tag/all?page=X
    while (currentPage <= 5) {
      // Construct URL with page parameter - use /tag/all?page=X format
      const pageUrl = currentPage === 1
        ? `${BNB_BLOG_URL}/tag/all?page=1`
        : `${BNB_BLOG_URL}/tag/all?page=${currentPage}`;

      console.log(`Fetching page ${currentPage}: ${pageUrl}`);

      try {
        // Fetch the blog index page
        const html = await fetchPageContent(pageUrl);

        // Extract blog post metadata - update extraction function below
        const blogPosts = extractBlogPostsFromTagPage(html);

        if (blogPosts.length === 0) {
          console.log(`No blog posts found on page ${currentPage}.`);
        } else {
          console.log(`Found ${blogPosts.length} blog posts on page ${currentPage}.`);

          // Add all posts from this page (will deduplicate later)
          allBlogPosts = [...allBlogPosts, ...blogPosts];
          console.log(`Total posts collected so far: ${allBlogPosts.length}`);
        }
      } catch (error) {
        console.error(`Error fetching page ${currentPage}: ${error.message}`);
      }

      currentPage++;
    }

    // After collecting all posts, deduplicate by URL
    const uniqueUrls = new Set();
    const uniqueBlogPosts = [];

    for (const post of allBlogPosts) {
      if (!uniqueUrls.has(post.url)) {
        uniqueUrls.add(post.url);
        uniqueBlogPosts.push(post);
      }
    }

    console.log(`After deduplication: Found ${uniqueBlogPosts.length} unique blog posts out of ${allBlogPosts.length} total posts`);
    allBlogPosts = uniqueBlogPosts;

    // Also try direct URL guessing for latest posts
    console.log("Trying additional methods to find more blog posts...");

    // Also try direct URL guessing for latest posts if we don't have enough
    if (allBlogPosts.length < 10) {
      console.log("Trying additional methods to find more blog posts...");

      // Try to find blog posts by looking at the site structure
      try {
        // Create a JSDOM instance to parse the HTML
        const dom = new JSDOM(html);
        const document = dom.window.document;

        // Look for all links in the page
        const links = Array.from(document.querySelectorAll('a[href]'));

        // Filter links that point to blog posts but weren't already found
        const blogLinks = links
          .map(link => link.getAttribute('href'))
          .filter(href =>
            href.includes('/blog/') &&
            !href.includes('?') &&
            !allBlogPosts.some(post => post.url.endsWith(href))
          )
          .map(href => {
            // Make URL absolute if it's relative
            if (!href.startsWith('http')) {
              const baseUrl = 'https://www.bnbchain.org';
              return href.startsWith('/') ? `${baseUrl}${href}` : `${baseUrl}/${href}`;
            }
            return href;
          });

        // Get unique URLs
        const uniqueBlogLinks = [...new Set(blogLinks)];

        if (uniqueBlogLinks.length > 0) {
          console.log(`Found ${uniqueBlogLinks.length} additional potential blog links.`);

          // Try to fetch content for these potential blog posts
          for (const url of uniqueBlogLinks.slice(0, 20)) { // Limit to 20 to avoid too many requests
            if (allBlogPosts.length >= 15) break; // Stop if we already have 15 posts

            if (!allBlogPosts.some(post => post.url === url)) {
              console.log(`Checking potential blog post: ${url}`);

              try {
                // Try to fetch the page to see if it's a valid blog post
                const browser = await puppeteer.launch({
                  headless: 'new',
                  args: ['--no-sandbox', '--disable-setuid-sandbox'],
                  timeout: 60000
                });

                try {
                  const page = await browser.newPage();
                  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

                  // Check if this is a blog post by looking for a title
                  const title = await page.evaluate(() => {
                    const titleEl = document.querySelector('h1, .title, [class*="title"], [class*="Title"]');
                    return titleEl ? titleEl.textContent.trim() : '';
                  });

                  if (title && title.length > 10) {
                    console.log(`Found valid blog post: "${title}" at ${url}`);
                    allBlogPosts.push({
                      title,
                      url,
                      category: 'Uncategorized',
                      date: new Date().toLocaleDateString()
                    });
                  }
                } finally {
                  await browser.close();
                }
              } catch (err) {
                console.log(`Error checking URL ${url}: ${err.message}`);
              }
            }
          }
        }
      } catch (err) {
        console.log(`Error looking for additional blog posts: ${err.message}`);
      }
    }

    // If we still don't have enough posts, try sitemap and archive pages
    if (allBlogPosts.length < 10) {
      console.log("Still need more blog posts, trying sitemap and archives...");
      const additionalPosts = await fetchAdditionalBlogPosts();

      if (additionalPosts.length > 0) {
        console.log(`Found ${additionalPosts.length} additional blog posts from sitemap/archives.`);

        // Filter out duplicates before adding to allBlogPosts
        const newPosts = additionalPosts.filter(newPost =>
          !allBlogPosts.some(existingPost => existingPost.url === newPost.url)
        );

        console.log(`Adding ${newPosts.length} unique new posts from sitemap/archives.`);
        allBlogPosts = [...allBlogPosts, ...newPosts];
      }
    }

    // Final attempt: explore blog URL patterns if we still don't have enough
    if (allBlogPosts.length < 10) {
      console.log("Making a final attempt to find more blog posts through URL exploration...");
      const exploredPosts = await exploreBlogPosts();

      if (exploredPosts.length > 0) {
        console.log(`URL exploration found ${exploredPosts.length} potential blog posts.`);

        // Filter out duplicates before adding
        const newPosts = exploredPosts.filter(newPost =>
          !allBlogPosts.some(existingPost => existingPost.url === newPost.url)
        );

        console.log(`Adding ${newPosts.length} unique new posts from URL exploration.`);
        allBlogPosts = [...allBlogPosts, ...newPosts];
      }
    }

    // Log the total number of blog posts found
    console.log(`Found a total of ${allBlogPosts.length} blog posts.`);

    if (allBlogPosts.length === 0) {
      console.log('No blog posts found. The website structure might have changed or be heavily JavaScript-dependent.');
      return;
    }

    // Create index file
    let indexContent = `# BNB Chain Blog Posts\n\n`;
    indexContent += `Last updated: ${new Date().toLocaleString()}\n\n`;

    // Process by category
    const categorizedPosts = {};

    // Process each blog post
    for (const post of allBlogPosts) {
      console.log(`Processing: ${post.title}`);

      // Fetch content for the blog post
      post.content = await fetchBlogPostContent(post.url);

      // Generate slug from title
      const slug = createSafeFilename(post.title);

      // Determine category
      const category = (post.category || 'uncategorized').toLowerCase();
      const categoryDir = path.join(OUTPUT_DIR, category);

      // Create category directory if it doesn't exist
      if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
      }

      // Save blog post to file
      const filename = `${slug}.md`;
      const filePath = path.join(categoryDir, filename);
      const markdown = blogToMarkdown(post);
      fs.writeFileSync(filePath, markdown);

      // Add to categorized posts
      if (!categorizedPosts[category]) {
        categorizedPosts[category] = [];
      }
      categorizedPosts[category].push({
        title: post.title,
        filename: `${category}/${filename}`,
        date: post.date
      });
    }

    // Add categories to index file
    const categories = Object.keys(categorizedPosts);
    for (const category of categories) {
      indexContent += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
      categorizedPosts[category].forEach(post => {
        indexContent += `- [${post.title}](${post.filename}) (${post.date})\n`;
      });
      indexContent += '\n';
    }

    // Save index file
    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.md'), indexContent);

    console.log(`Successfully processed ${allBlogPosts.length} blog posts. Saved to ${OUTPUT_DIR}`);
  } catch (error) {
    console.error(`Error processing blog posts: ${error.message}`);
  }
}

// Run the script
processBlogPosts();

