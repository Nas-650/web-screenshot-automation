# Screenshot Retry Utility

A Node.js utility for retrying screenshots of URLs that previously failed.

## Overview

This tool reads URLs from a CSV file, takes screenshots using the Firecrawl API, and saves them to domain-specific folders. It also updates a log file in each domain folder with information about each screenshot.

## Prerequisites

- Node.js 14+
- NPM or Yarn

## Installation

1. Clone or download this repository
2. Install dependencies:

```bash
npm install
```

## Required Dependencies

This script requires the following NPM packages:

```bash
npm install csv-parser csv-writer date-fns node-fetch
```

## Configuration

Before running the script, set up your configuration:

1. Create a `missing_screenshots.csv` file with the URLs to process (format: url,timestamp,domain)
2. Set your Firecrawl API key either as an environment variable or in the script:

```bash
export FIRECRAWL_API_KEY=your_api_key_here
```

## Usage

Run the script with:

```bash
node screenshot-retry.js
```

## Output Structure

The script organizes screenshots into folders by domain:

```
OUTPUT/OUTPUT/
├── domain1.com/
│   ├── page-name_timestamp.png
│   ├── another-page_timestamp.png
│   └── log.csv
├── domain2.com/
│   ├── home_timestamp.png
│   └── log.csv
└── ...
```

Each `log.csv` file contains:
- Page URL
- Screenshot Filename
- Timestamp (AEST, UTC+10)

## CSV Format

The `missing_screenshots.csv` file should contain the following columns:
1. URL (required)
2. Timestamp (optional)
3. Domain (optional)

Example:
```
url,timestamp,domain
https://example.com/page1,2023-04-19 12:34:56,example.com
https://example.org/page2,2023-04-19 13:45:12,example.org
```

If no domain is provided, it will be extracted from the URL.

## Troubleshooting

If you encounter issues:

1. Verify your API key is correctly set
2. Check the CSV file format
3. Ensure the OUTPUT directory exists
4. Check network connectivity for API access 