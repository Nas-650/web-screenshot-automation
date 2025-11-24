#!/usr/bin/env node

/**
 * Firecrawl Website Scraper
 * 
 * This script uses a two-step approach:
 * 1. Get all page links from the target website
 * 2. Get screenshots of each discovered page
 * 
 * Usage:
 *   node firecrawl-scraper.js --url https://example.com
 *   node firecrawl-scraper.js --urls-file urls.txt
 */

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const { parse } = require('url');
const { createObjectCsvWriter } = require('csv-writer');
const { format } = require('date-fns');
const axios = require('axios');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');

// Define command-line options
program
  .name('firecrawl-scraper')
  .description('Scrape websites using Firecrawl API with organized output')
  .option('-u, --url <url>', 'Single URL to scrape')
  .option('-f, --urls-file <path>', 'File containing URLs to scrape, one per line')
  .option('-o, --output-dir <dir>', 'Output directory for results', './output')
  .option('-k, --api-key <key>', 'Firecrawl API key (will use FIRECRAWL_API_KEY env var if not provided)')
  .option('-d, --delay <seconds>', 'Delay between processing pages in seconds', 1)
  .option('-s, --screenshot-delay <seconds>', 'Delay after each screenshot in seconds', 70)
  .option('-m, --main-content-only', 'Extract only main content of the page')
  .option('-v, --verbose', 'Display detailed information during scraping')
  .option('-l, --max-links <number>', 'Maximum number of links to process per domain', 100)
  .option('--same-domain-only', 'Only process links from the same domain', false)
  .parse(process.argv);

// Store program options in a global variable
const options = program.opts();

// Get API key from options or environment variable
function getApiKey() {
  if (options.apiKey) {
    return options.apiKey;
  }
  
  if (process.env.FIRECRAWL_API_KEY) {
    return process.env.FIRECRAWL_API_KEY;
  }
  
  return 'fc-165b7e7c4d044eadacc75a7968bcad33';
}

// Extract domain from URL
function extractDomain(url) {
  try {
    const parsedUrl = parse(url);
    let domain = parsedUrl.hostname || '';
    
    // Remove 'www.' if present
    domain = domain.replace(/^www\./, '');
    
    return domain;
  } catch (error) {
    console.error(`Error extracting domain from ${url}: ${error.message}`);
    return url.replace(/https?:\/\/(www\.)?/, '').split('/')[0];
  }
}

// Convert relative URL to absolute
function toAbsoluteUrl(baseUrl, relativeUrl) {
  try {
    // If it's already an absolute URL, return as is
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
      return relativeUrl;
    }
    
    // Handle protocol-relative URLs
    if (relativeUrl.startsWith('//')) {
      const parsedBase = parse(baseUrl);
      return `${parsedBase.protocol}${relativeUrl}`;
    }
    
    // Create a URL object to handle the conversion easily
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
      // If URL constructor fails, use a more manual approach
      // Parse the base URL
      const parsedBase = new URL(baseUrl);
      
      // Handle root-relative URLs
      if (relativeUrl.startsWith('/')) {
        return `${parsedBase.origin}${relativeUrl}`;
      }
      
      // Handle page-relative URLs
      // Remove the filename part from pathname if present
      let pathname = parsedBase.pathname;
      if (!pathname.endsWith('/')) {
        pathname = pathname.substring(0, pathname.lastIndexOf('/') + 1);
      }
      
      return `${parsedBase.origin}${pathname}${relativeUrl}`;
    }
  } catch (error) {
    console.error(`Error converting relative URL: ${error.message}`);
    return relativeUrl;
  }
}

// Filter links to only include those from the same domain
function filterLinksSameDomain(baseUrl, links) {
  const baseDomain = extractDomain(baseUrl);
  console.log(`Filtering links to domain: ${baseDomain}`);
  
  return links.filter(link => {
    // Skip empty links, javascript: links, mailto: links, etc.
    if (!link || 
        link.startsWith('javascript:') || 
        link.startsWith('mailto:') || 
        link.startsWith('tel:') ||
        link === '#' ||
        link.startsWith('#')) {
      return false;
    }
    
    // Convert relative URLs to absolute
    const absoluteUrl = toAbsoluteUrl(baseUrl, link);
    
    // Check if the domain matches
    const linkDomain = extractDomain(absoluteUrl);
    const isSame = linkDomain === baseDomain;
    
    if (options.verbose && !isSame) {
      console.log(`Filtered out external link: ${absoluteUrl} (${linkDomain})`);
    }
    
    return isSame;
  });
}

// Get path segment for URL
function getPathSegment(url) {
  try {
    const parsedUrl = parse(url);
    let pathSegment = parsedUrl.pathname || '';
    
    // Remove leading and trailing slashes
    pathSegment = pathSegment.replace(/^\/|\/$/g, '');
    
    // If empty (homepage), use 'home'
    if (!pathSegment) {
      return 'home';
    }
    
    // Replace slashes with underscores to make a valid filename
    return pathSegment.replace(/\//g, '_').toLowerCase();
  } catch (error) {
    console.error(`Error extracting path from ${url}: ${error.message}`);
    return 'page';
  }
}

// Create timestamp string in format yyyy-MM-dd-HH-mm-AEST
function getTimestamp() {
  const now = new Date();
  return format(now, 'yyyy-MM-dd-HH-mm') + '-AEST';
}

// Get current timestamp in AEST for CSV logging
function getAESTTimestamp() {
  // Create a date object
  const now = new Date();
  
  // Convert to Australian Eastern Standard Time (UTC+10)
  // First get UTC time in milliseconds
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  
  // Then add the AEST offset (UTC+10 = 10 hours)
  const aestTime = new Date(utcTime + (10 * 3600000));
  
  // Format the date as yyyy-MM-dd HH:mm:ss AEST
  return format(aestTime, 'yyyy-MM-dd HH:mm:ss') + ' AEST';
}

// Ensure directory exists
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    if (options.verbose) {
      console.log(`Created directory: ${dirPath}`);
    }
  }
}

// Read URLs from a file
function readUrlsFromFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (error) {
    console.error(`Error reading URLs file: ${error.message}`);
    return [];
  }
}

// Download image from URL
function downloadImage(imageUrl, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading image from: ${imageUrl}`);
    
    // Create the directory if it doesn't exist
    const dir = path.dirname(outputPath);
    ensureDirectoryExists(dir);
    
    // Create a write stream
    const file = fs.createWriteStream(outputPath);
    
    // Choose http or https client based on the URL
    const client = imageUrl.startsWith('https') ? https : http;
    
    client.get(imageUrl, (response) => {
      // Check if the response is an image
      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('image/')) {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(new Error(`URL does not point to an image: ${contentType}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log(`Image saved to: ${outputPath}`);
        resolve(outputPath);
      });
      
      file.on('error', (err) => {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

// Save screenshot to file (handles base64 data)
async function saveScreenshot(screenshotData, url, outputDir) {
  try {
    // Extract domain and path segment
    const domain = extractDomain(url);
    const pathSegment = getPathSegment(url);
    const timestamp = getTimestamp();
    
    // Create domain-specific directory
    const domainDir = path.join(outputDir, domain);
    ensureDirectoryExists(domainDir);
    
    // Create filename with path segment and timestamp
    const filename = `${pathSegment}_${timestamp}.png`;
    const outputPath = path.join(domainDir, filename);
    
    // Check if screenshotData is a URL or base64 data
    if (typeof screenshotData === 'string' && (screenshotData.startsWith('http://') || screenshotData.startsWith('https://'))) {
      // It's a URL, download the image
      await downloadImage(screenshotData, outputPath);
    } else {
      // It's base64 data, convert and save
      const imageBuffer = Buffer.from(screenshotData, 'base64');
      fs.writeFileSync(outputPath, imageBuffer);
    }
    
    if (options.verbose) {
      console.log(`Screenshot saved to: ${outputPath}`);
    }
    
    return {
      domain,
      path: pathSegment,
      filename,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Error saving screenshot: ${error.message}`);
    return null;
  }
}

// Update log CSV file
async function updateLogFile(domain, data, outputDir) {
  try {
    const logPath = path.join(outputDir, domain, 'log.csv');
    const isNewFile = !fs.existsSync(logPath);
    
    const csvWriter = createObjectCsvWriter({
      path: logPath,
      header: [
        { id: 'url', title: 'Page URL' },
        { id: 'filename', title: 'Screenshot Filename' },
        { id: 'timestamp', title: 'Timestamp (in AEST, UTC+10)' }
      ],
      append: !isNewFile
    });
    
    // Simplify the data to only include the required fields
    const logEntry = {
      url: data.url,
      filename: data.filename || '',
      timestamp: getAESTTimestamp()
    };
    
    await csvWriter.writeRecords([logEntry]);
    
    if (options.verbose) {
      console.log(`  📝 Log updated: ${logPath}`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error updating log file: ${error.message}`);
    return false;
  }
}

// Step 1: Get all links from a website using axios
async function getLinksFromWebsite(url) {
  try {
    console.log(`🔍 Discovering links from: ${url}`);
    
    const apiKey = getApiKey();
    
    // Create request options according to the provided sample
    const axiosOptions = {
      method: 'POST',
      url: 'https://api.firecrawl.dev/v1/scrape',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      data: {
        url: url,
        formats: ['links'],
        onlyMainContent: false
      }
    };
    
    // Make the API request using axios
    const response = await axios.request(axiosOptions);
    
    if (!response.data || !response.data.data) {
      throw new Error('No data returned from API');
    }
    
    const data = response.data.data;
    let links = [];
    if (data.links) {
      links = data.links;
      console.log(links,'links', links.length)
      // Convert all relative links to absolute URLs
      links = links.map(link => toAbsoluteUrl(url, link));
      
      // Remove duplicates
      links = [...new Set(links)];
      
      console.log(`Found ${links.length, links} total links on the page`);
      
      // Filter links to only include those from the same domain if configured
      if (options.sameDomainOnly) {
        links = filterLinksSameDomain(url, links);
        console.log(`Filtered to ${links.length} links from the same domain`);
      }
      
      // Limit the number of links to process
      if (options.maxLinks && links.length > options.maxLinks) {
        console.log(`Limiting to ${options.maxLinks} links for processing`);
        links = links.slice(0, options.maxLinks);
      }
    }
    
    return links;
  } catch (error) {
    console.error(`❌ Error getting links from ${url}: ${error.message}`);
    if (error.response) {
      console.error(`  Response status: ${error.response.status}`);
      console.error(`  Response data: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    return [];
  }
}

// Step 2: Take screenshot of a single URL using direct API call
async function takeScreenshot(url) {
  try {
    if (options.verbose) {
      console.log(`📷 Taking screenshot of: ${url}`);
    }
    
    const apiKey = getApiKey();
    
    // Use fetch to make the request directly to the API
    const requestOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        formats: ['screenshot@fullPage'],
        onlyMainContent: options.mainContentOnly || false,
        waitFor: 1000,
        mobile: false,
        timeout: 60000,
        actions: [{
          type: 'screenshot',
          screenshots: 'array',
          fullPage: true
        }],
        blockAds: true
      })
    };
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', requestOptions);
    
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data || !data.data) {
      throw new Error('No data returned from API');
    }
    
    const responseData = data.data;
    const domain = extractDomain(url);
    
    // Save screenshot if available
    let screenshotResult = null;
    
    // Check for screenshot URL first
    if (responseData.screenshotUrl) {
      console.log(`Found screenshot URL: ${responseData.screenshotUrl}`);
      const domainDir = path.join(options.outputDir, domain);
      const pathSegment = getPathSegment(url);
      const timestamp = getTimestamp();
      const filename = `${pathSegment}_${timestamp}.png`;
      const outputPath = path.join(domainDir, filename);
      
      try {
        await downloadImage(responseData.screenshotUrl, outputPath);
        screenshotResult = {
          domain,
          path: pathSegment,
          filename,
          timestamp: new Date().toISOString()
        };
      } catch (downloadError) {
        console.error(`Failed to download screenshot from URL: ${downloadError.message}`);
      }
    }
    // If no URL or download failed, try base64 data
    else if (responseData.screenshots && responseData.screenshots.length > 0) {
      const screenshot = responseData.screenshots[0];
      screenshotResult = await saveScreenshot(
        screenshot.data,
        url,
        options.outputDir
      );
    } else if (responseData.screenshot) {
      // Handle case where screenshot is directly in the response
      screenshotResult = await saveScreenshot(
        responseData.screenshot,
        url,
        options.outputDir
      );
    }
    
    // Log the result
    if (screenshotResult) {
      await updateLogFile(domain, {
        url,
        filename: screenshotResult.filename
      }, options.outputDir);
    }
    
    // Add a small delay after each successful screenshot to avoid hitting rate limits
    const screenshotDelayMs = (options.screenshotDelay || 50) * 1000;
    if (options.verbose) {
      console.log(`  ⏱️  Waiting ${options.screenshotDelay || 50} seconds after screenshot...`);
    }
    await new Promise(resolve => setTimeout(resolve, screenshotDelayMs));
    
    return {
      success: true,
      title: responseData.title || url,
      screenshot: screenshotResult ? screenshotResult.filename : null
    };
  } catch (error) {
    console.error(`❌ Error taking screenshot of ${url}: ${error.message}`);
    
    // Extract domain and ensure domain directory exists before logging
    const domain = extractDomain(url);
    const domainDir = path.join(options.outputDir, domain);
    ensureDirectoryExists(domainDir);
    
    // Log the error in the CSV
    await updateLogFile(domain, {
      url,
      filename: '' // Keep this empty to maintain CSV structure
    }, options.outputDir);
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Process a single site - get links and take screenshots
async function processSite(url) {
  console.log(`\n🌐 Processing site: ${url}`);
  
  // Step 1: Get all links from the site
  let links = await getLinksFromWebsite(url);
  
  // Force filtering to same domain links regardless of command-line options
  // This ensures we only scrape within the same website
  const originalSetting = options.sameDomainOnly;
  options.sameDomainOnly = true;
  links = filterLinksSameDomain(url, links);
  options.sameDomainOnly = originalSetting;
  
  console.log(`Found ${links.length} links from the same domain as ${url}`);
  
  // Add a delay after getting links before processing screenshots
  const linkDiscoveryDelayMs = 10000; // 10 seconds
  console.log(`Waiting 10 seconds before processing screenshots...`);
  await new Promise(resolve => setTimeout(resolve, linkDiscoveryDelayMs));
  
  // Always include the original URL if no links were found
  const urlsToProcess = links.length > 0 ? links : [url];
  
  // Step 2: Process each link
  console.log(`\n📸 Taking screenshots of ${urlsToProcess.length} pages...`);
  
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < urlsToProcess.length; i++) {
    const pageUrl = urlsToProcess[i];
    console.log(`\n[${i+1}/${urlsToProcess.length}] Processing: ${pageUrl}`);
    
    const result = await takeScreenshot(pageUrl);
    
    if (result.success) {
      successCount++;
      console.log(`  ✓ Success: ${result.title || pageUrl}`);
      if (result.screenshot) {
        console.log(`  📷 Screenshot: ${result.screenshot}`);
      }
    } else {
      errorCount++;
      console.log(`  ✗ Failed: ${result.error}`);
    }
    
    // Add delay between requests (except for the last one)
    if (i < urlsToProcess.length - 1) {
      const delayMs = options.delay * 1000;
      if (options.verbose) {
        console.log(`  ⏱️  Waiting ${options.delay} seconds...`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  console.log(`\n🏁 Site processing completed for ${url}:`);
  console.log(`  ✓ Success: ${successCount} pages`);
  console.log(`  ✗ Failed: ${errorCount} pages`);
  console.log(`  Total: ${urlsToProcess.length} pages`);
  
  return {
    url,
    totalPages: urlsToProcess.length,
    successCount,
    errorCount
  };
}

// Process a batch of root URLs
async function processBatch(urls) {
  console.log(`Starting batch processing of ${urls.length} sites...`);
  
  const results = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n🔄 Processing site ${i+1}/${urls.length}: ${url}`);
    
    const result = await processSite(url);
    results.push(result);
    
    // Add delay between sites (except for the last one)
    if (i < urls.length - 1) {
      const delayMs = (options.delay * 3) * 1000; // Longer delay between sites
      console.log(`\n⏱️  Waiting ${options.delay * 2} seconds before next site...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // Print summary
  console.log(`\n📊 Batch processing summary:`);
  let totalPages = 0;
  let totalSuccess = 0;
  let totalErrors = 0;
  
  results.forEach(result => {
    console.log(`  ${result.url}: ${result.successCount}/${result.totalPages} pages`);
    totalPages += result.totalPages;
    totalSuccess += result.successCount;
    totalErrors += result.errorCount;
  });
  
  console.log(`\n📈 Overall statistics:`);
  console.log(`  ✓ Success: ${totalSuccess} pages`);
  console.log(`  ✗ Failed: ${totalErrors} pages`);
  console.log(`  Total: ${totalPages} pages across ${urls.length} sites`);
}

// Main function
async function main() {
  // Validate options
  if (!options.url && !options.urlsFile) {
    console.error('Error: Either --url or --urls-file must be specified');
    program.help();
    return;
  }
  
  // Ensure output directory exists
  ensureDirectoryExists(options.outputDir);
  
  try {
    let urls = [];
    
    if (options.urlsFile) {
      urls = readUrlsFromFile(options.urlsFile);
      if (urls.length === 0) {
        console.error('No valid URLs found in the specified file');
        return;
      }
    } else if (options.url) {
      urls = [options.url];
    }
    
    await processBatch(urls);
  } catch (error) {
    console.error(`Error in main process: ${error.message}`);
  }
}

// Start the application
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
}); 