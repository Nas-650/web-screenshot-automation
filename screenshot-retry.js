#!/usr/bin/env node

/**
 * Screenshot Retry Script
 * 
 * This script reads missing URLs from missing_screenshots.csv, takes screenshots,
 * and organizes them into appropriate domain folders.
 * 
 * Usage:
 *   node screenshot-retry.js
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const { format } = require('date-fns');
const fetch = require('node-fetch');

// Configuration
const API_KEY = process.env.FIRECRAWL_API_KEY || 'fc-165b7e7c4d044eadacc75a7968bcad33';
const OUTPUT_DIR = './OUTPUT/OUTPUT';
const MISSING_SCREENSHOTS_FILE = './missing_screenshots.csv';
const DELAY_BETWEEN_REQUESTS = 40000; // 2 seconds between API calls

// Helper Functions
const extractDomain = (url) => {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch (error) {
    console.error(`Error extracting domain from ${url}: ${error.message}`);
    return null;
  }
};

const createPathSegments = (url) => {
  try {
    const { pathname, hash } = new URL(url);
    // Get clean path without leading/trailing slashes
    let segments = pathname.replace(/^\/|\/$/g, '').split('/');
    
    // Handle hash fragments in the URL
    if (hash && hash !== '#') {
      segments.push(hash.substring(1));
    }
    
    // If path is empty, use 'home'
    if (segments.length === 1 && segments[0] === '') {
      return 'home';
    }
    
    return segments.join('-').toLowerCase() || 'home';
  } catch (error) {
    console.error(`Error creating path segments for ${url}: ${error.message}`);
    return 'unknown';
  }
};

const generateTimestamp = () => {
  return format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
};

const ensureDirectoryExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
};

const downloadImage = async (imageUrl, outputPath) => {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    
    const buffer = await response.buffer();
    fs.writeFileSync(outputPath, buffer);
    console.log(`Image saved to ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading image: ${error.message}`);
    return false;
  }
};

const saveBase64Image = (base64Data, outputPath) => {
  try {
    // Remove the data URL prefix if present
    const data = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Image saved to ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`Error saving base64 image: ${error.message}`);
    return false;
  }
};

const updateLogFile = (domainDir, url, screenshotFilename, timestamp) => {
  const logFilePath = path.join(domainDir, 'log.csv');
  
  // Check if log file exists and create header if it doesn't
  const fileExists = fs.existsSync(logFilePath);
  
  const csvWriter = createObjectCsvWriter({
    path: logFilePath,
    header: [
      { id: 'url', title: 'Page URL' },
      { id: 'filename', title: 'Screenshot Filename' },
      { id: 'timestamp', title: 'Timestamp (AEST, UTC+10)' }
    ],
    append: fileExists
  });

  return csvWriter.writeRecords([{
    url,
    filename: screenshotFilename,
    timestamp
  }]);
};

const takeScreenshot = async (url) => {
  try {
    console.log(`Taking screenshot of ${url}...`);
    
    const requestOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        formats: ['screenshot@fullPage'],
        onlyMainContent: false,
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
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    if (data.success) {
      return {
        success: true,
        screenshotUrl: data.data.screenshot,
        base64Data: data.base64
      };
    } else {
      throw new Error(data.message || 'Unknown API error');
    }
  } catch (error) {
    console.error(`Error taking screenshot: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
};

// Delay function to avoid rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Parse the missing_screenshots.csv file
const parseMissingScreenshots = () => {
  return new Promise((resolve, reject) => {
    const entries = [];
    
    fs.createReadStream(MISSING_SCREENSHOTS_FILE)
      .pipe(csv({ headers: false }))  // Add this option to disable headers
      .on('data', (row) => {
        // For CSV without headers, use indices
        if (row[1] && row[1].includes('http')) {
          // Format is domain,url,timestamp
          entries.push({
            url: row[1],
            timestamp: row[2] || format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
            domain: row[0]
          });
        } else if (row[0] && row[0].includes('http')) {
          // Format is url,timestamp,domain
          entries.push({
            url: row[0],
            timestamp: row[1] || format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
            domain: row[2] || extractDomain(row[0])
          });
        }
      })
      .on('end', () => {
        resolve(entries);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
};

// Main function
const retryScreenshots = async () => {
  console.log('Starting screenshot retry process...');
  
  try {
    const missingEntries = await parseMissingScreenshots();
    console.log(`Found ${missingEntries.length} URLs to process`);
    
    const results = {
      success: 0,
      failure: 0
    };
    
    // Process each URL
    for (const [index, entry] of missingEntries.entries()) {
      const { url, timestamp } = entry;
      let { domain } = entry;
      
      // Extract domain from URL if not provided
      if (!domain) {
        domain = extractDomain(url);
        if (!domain) {
          console.error(`Could not extract domain from ${url}, skipping...`);
          results.failure++;
          continue;
        }
      }
      
      console.log(`[${index + 1}/${missingEntries.length}] Processing: ${url}`);
      
      // Ensure domain directory exists
      const domainDir = path.join(OUTPUT_DIR, domain);
      ensureDirectoryExists(domainDir);
      
      // Generate filename based on URL path
      const pathSegment = createPathSegments(url);
      const screenshotTimestamp = generateTimestamp();
      const screenshotFilename = `${pathSegment}_${screenshotTimestamp}.png`;
      const outputPath = path.join(domainDir, screenshotFilename);
      
      // Take screenshot
      const screenshotResult = await takeScreenshot(url);
      console.log(screenshotResult,'screenshotResult');
      if (screenshotResult.success) {
        let saved = false;
        
        // Try to download from URL first
        if (screenshotResult.screenshotUrl) {
          saved = await downloadImage(screenshotResult.screenshotUrl, outputPath);
        }
        
        // If URL download failed or no URL was provided, try base64
        if (!saved && screenshotResult.base64Data) {
          saved = saveBase64Image(screenshotResult.base64Data, outputPath);
        }
        
        if (saved) {
          // Update log file
          await updateLogFile(domainDir, url, screenshotFilename, format(new Date(), 'yyyy-MM-dd HH:mm:ss'));
          results.success++;
          console.log(`✓ Successfully captured screenshot for ${url}`);
        } else {
          results.failure++;
          console.error(`✗ Failed to save screenshot for ${url}`);
        }
      } else {
        results.failure++;
        console.error(`✗ Failed to take screenshot for ${url}: ${screenshotResult.error}`);
      }
      
      // Add a delay between requests to avoid rate limiting
      if (index < missingEntries.length - 1) {
        console.log(`Waiting ${DELAY_BETWEEN_REQUESTS/1000} seconds before next request...`);
        await delay(DELAY_BETWEEN_REQUESTS);
      }
    }
    
    console.log('\nProcessing complete');
    console.log(`Success: ${results.success}, Failures: ${results.failure}`);
    
    if (results.failure > 0) {
      console.log(`\nNote: ${results.failure} URLs failed. You may want to retry these later.`);
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
};

// Run the main function
retryScreenshots().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 