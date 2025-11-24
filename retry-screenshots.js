#!/usr/bin/env node

/**
 * Retry Failed Screenshots Script
 * 
 * This script reads from missing_screenshots.csv, takes screenshots of URLs that previously failed,
 * saves them to the appropriate domain folders, and updates the log.csv files.
 * 
 * Usage:
 *   node retry-screenshots.js
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const { format } = require('date-fns');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');

// Configuration
const API_KEY = process.env.FIRECRAWL_API_KEY || 'YOUR_FIRECRAWL_API_KEY'; // Replace with your actual API key or use environment variable
const OUTPUT_DIR = './OUTPUT/OUTPUT';
const MISSING_SCREENSHOTS_FILE = './missing_screenshots.csv';
const DELAY_BETWEEN_SCREENSHOTS = 10; // seconds

// Helper Functions
const extractDomain = (url) => {
  try {
    const hostname = new URL(url).hostname;
    return hostname;
  } catch (error) {
    console.error(`Error extracting domain from ${url}: ${error.message}`);
    return null;
  }
};

const createPathSegments = (url) => {
  try {
    const { pathname } = new URL(url);
    // Remove leading and trailing slashes and split by slash
    const segments = pathname.replace(/^\/|\/$/g, '').split('/');
    
    // If pathname is empty or just '/', use 'home'
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
  const csvWriter = createObjectCsvWriter({
    path: logFilePath,
    header: [
      { id: 'url', title: 'Page URL' },
      { id: 'filename', title: 'Screenshot Filename' },
      { id: 'timestamp', title: 'Timestamp (AEST, UTC+10)' }
    ],
    append: fs.existsSync(logFilePath)
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
    
    const response = await fetch('https://api.firecrawl.io/v1/screenshot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Firecrawl-API-Key': API_KEY
      },
      body: JSON.stringify({
        url,
        fullPage: true,
        format: 'png'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.success) {
      return {
        success: true,
        screenshotUrl: data.screenshotUrl,
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

// Main function
const retryMissingScreenshots = async () => {
  const results = {
    success: 0,
    failure: 0
  };

  const missingUrls = [];
  
  // Read the missing screenshots file
  fs.createReadStream(MISSING_SCREENSHOTS_FILE)
    .pipe(csv())
    .on('data', (row) => {
      if (row.url) {
        missingUrls.push(row.url);
      }
    })
    .on('end', async () => {
      console.log(`Found ${missingUrls.length} URLs to retry`);
      
      for (const url of missingUrls) {
        const domain = extractDomain(url);
        
        if (!domain) {
          console.error(`Could not extract domain from ${url}, skipping...`);
          results.failure++;
          continue;
        }
        
        const domainDir = path.join(OUTPUT_DIR, domain);
        ensureDirectoryExists(domainDir);
        
        const pathSegment = createPathSegments(url);
        const timestamp = generateTimestamp();
        const screenshotFilename = `${pathSegment}_${timestamp}.png`;
        const outputPath = path.join(domainDir, screenshotFilename);
        
        const screenshotResult = await takeScreenshot(url);
        
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
            console.log(`Successfully processed ${url}`);
          } else {
            results.failure++;
            console.error(`Failed to save screenshot for ${url}`);
          }
        } else {
          results.failure++;
          console.error(`Failed to take screenshot for ${url}: ${screenshotResult.error}`);
        }
        
        // Add a delay to avoid rate limiting
        await delay(2000);
      }
      
      console.log('Processing complete');
      console.log(`Success: ${results.success}, Failures: ${results.failure}`);
    });
};

// Run the main function
retryMissingScreenshots().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 