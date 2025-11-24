const options = {
    method: 'POST',
    headers: {Authorization: 'Bearer fc-1ac917ab61b84b2388f6f30bdc18ec33', 'Content-Type': 'application/json'},
    body: '{"url":"https://snowyrivercaravans.com.au/","formats":["screenshot@fullPage"],"onlyMainContent":false,"waitFor":2000,"mobile":false,"skipTlsVerification":false,"timeout":30000,"location":{"country":"US","languages":["en-US"]},"removeBase64Images":true,"blockAds":true,"proxy":"basic"}'
  };
  
  fetch('https://api.firecrawl.dev/v1/scrape', options)
    .then(response => response.json())
    .then(response => console.log(response))
    .catch(err => console.error(err));

