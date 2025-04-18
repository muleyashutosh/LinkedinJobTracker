import { google } from "googleapis";

// Function to authorize Google Sheets
async function authorize() {
  let credentials;
  // If GOOGLE_CREDENTIALS environment variable is set, use it.
  if (process.env.GOOGLE_CREDENTIALS) {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  }
  const { client_email, private_key } = credentials;
  const auth = new google.auth.JWT({
    email: client_email,
    key: private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  await auth.authorize();
  return auth;
}

// Function to get or create a sheet for today within the specified spreadsheet
async function getOrCreateSheet(auth, spreadsheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const today = new Date().toISOString().split("T")[0]; // e.g. "2025-03-10"

  // Retrieve spreadsheet metadata to check existing sheet titles
  const sheetMetadata = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetsList = sheetMetadata.data.sheets || [];
  const sheetTitles = sheetsList.map((sheet) => sheet.properties.title);

  // If today's sheet already exists, return its title
  if (sheetTitles.includes(today)) {
    return today;
  }

  // If no sheet exists with today's date, create a new one
  sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          addSheet: {
            properties: {
              title: today,
              gridProperties: {
                rowCount: 1000,
                columnCount: 4,
              },
            },
          },
        },
      ],
    },
  });

  // Write headers in columns A-D (JobId, Title, Company, Url)
  sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${today}!A1:D1`,
    valueInputOption: "RAW",
    resource: {
      values: [["JobId", "Title", "Company", "Url"]],
    },
  });

  return today;
}

// Function to get existing JobIds from the given sheet (assumes headers in row 1)
async function getExistingJobIds(auth, spreadsheetId, sheetName) {
  const sheets = google.sheets({ version: "v4", auth });
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`,
    });
    const values = response.data.values || [];
    // Skip the header row (index 0)
    const existingIds = new Set();
    for (let i = 1; i < values.length; i++) {
      if (values[i] && values[i][0]) {
        existingIds.add(values[i][0]);
      }
    }
    return existingIds;
  } catch (error) {
    console.error("Error fetching existing job IDs:", error);
    return new Set();
  }
}

// Function to append job data to the sheet (with deduplication)
async function appendJobsToSheet(auth, spreadsheetId, sheetName, jobsData) {
  const sheets = google.sheets({ version: "v4", auth });
  // Get existing JobIds from the sheet to avoid duplicates
  const existingJobIds = await getExistingJobIds(
    auth,
    spreadsheetId,
    sheetName
  );
  // Filter out jobs that already exist
  const newJobs = jobsData.filter((job) => !existingJobIds.has(job.id));
  if (newJobs.length === 0) {
    return { added: 0, skipped: jobsData.length };
  }
  // Prepare rows: each row has [JobId, Title, Company, Url]
  const rows = newJobs.map((job) => [
    job.id || "N/A",
    job.title || "N/A",
    job.company || "N/A",
    job.url || "N/A",
  ]);
  // Append rows using the append API (it will automatically detect the last row)
  sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    resource: {
      values: rows,
    },
  });
  return { added: rows.length, skipped: jobsData.length - rows.length };
}

// Function to extract job data from the LinkedIn API response
function extractJobData(apiResponse) {
  if (
    !apiResponse ||
    !apiResponse.data ||
    !Array.isArray(apiResponse.data.data)
  ) {
    return [];
  }
  return apiResponse.data.data.map((job) => ({
    id:
      job.jobId ||
      job.id ||
      `${job.companyName}-${job.title}`.replace(/\s+/g, "-"),
    title: job.title || "",
    company: job.company && job.company.name ? job.company.name : "",
    url: job.jobUrl || job.url || "",
  }));
}

// Core function to fetch jobs from the LinkedIn API and process them
async function processJobs() {
  // Define query parameters
  const keywords = "software intern";
  const location = "103644278";
  const datePosted = "past24Hours";
  const titleIds = "4171";
  const sort = "mostRelevant";
  const page = 1;

  const params = {
    keywords: encodeURIComponent(keywords),
    locationId: encodeURIComponent(location),
    datePosted,
    titleIds,
    sort,
    page,
  };

  const url = `https://linkedin-data-api.p.rapidapi.com/search-jobs?${new URLSearchParams(
    params
  ).toString()}`;

  const options = {
    method: "GET",
    headers: {
      "x-rapidapi-key": process.env.RAPIDAPI_KEY,
      "x-rapidapi-host": "linkedin-data-api.p.rapidapi.com",
    },
  };

  // Fetch jobs data from the LinkedIn API
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`API responded with status: ${response.status}`);
  }
  const result = await response.json();
  const apiResponse = {
    success: true,
    data: result,
    query: { keywords, location, datePosted, titleIds, sort, page },
  };
  const jobsData = extractJobData(apiResponse);

  // Process Google Sheets updates if there are jobs
  if (jobsData.length > 0) {
    const auth = await authorize();
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = await getOrCreateSheet(auth, spreadsheetId);
    const result = await appendJobsToSheet(
      auth,
      spreadsheetId,
      sheetName,
      jobsData
    );
    console.log(
      `Jobs processed. Added: ${result.added}, Skipped: ${result.skipped}`
    );
    return {
      success: true,
      sheetName,
      jobsProcessed: jobsData.length,
      jobsAdded: result.added,
      jobsSkipped: result.skipped,
    };
  } else {
    console.log("No new jobs found.");
    return { success: true, message: "No new jobs found" };
  }
}

(async () => {
  try {
    console.log("Processing jobs...");
    const result = await processJobs();
    console.log("Processing Successful");
  } catch (error) {
    console.error("Error running cron job:", error);
  }
})();
