const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const sqlite3 = require('sqlite3').verbose();
const csvWriter = require('csv-writer').createObjectCsvWriter;
const app = express();
const port = 3005;

app.set('view engine', 'ejs');
app.use(express.static('public'));

// Configure storage for multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Create or open the database
const db = new sqlite3.Database('./archive.db', (err) => {
    if (err) {
        console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
});

// Create the table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS archive (
    id INTEGER PRIMARY KEY,
    date TEXT,
    response TEXT,
    missing_orders_count INTEGER,
    aging_orders_count INTEGER,
    uncanceled_orders_count INTEGER
)`);

// Route to serve the upload form
app.get('/upload', (req, res) => {
    res.render('upload'); // Assuming you have an 'upload.ejs' template
});

// Timestamp stuff
const getDateTime = () => {
    const options = {
        timeZone: 'America/New_York',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
hour12: false
    };

    const formatter = new Intl.DateTimeFormat([], options);
    return formatter.format(new Date());
};

const formatEST = (date) => {
    const options = {
        timeZone: 'America/New_York',
        year: '2-digit', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', 
        hour12: true
    };

    const formatter = new Intl.DateTimeFormat('en-US', options);
    return formatter.format(new Date(date));
};

// Handle file upload and data processing
app.post('/upload', upload.fields([{ name: 'eomData' }, { name: 'RadialData' }]), (req, res) => {
    let eomData = req.files['eomData'][0].buffer.toString();
    let RadialData = req.files['RadialData'][0].buffer.toString();

    // Preprocess the EOM data to remove the first two lines
    const eomDataLines = eomData.split('\n').slice(2).join('\n');

    // Parse the CSV data
    const parsedEomData = Papa.parse(eomDataLines, { header: true }).data;
    const parsedRadialData = Papa.parse(RadialData, { header: true }).data;
    
    // Initialize objects to store missing and aging orders
    const missingOrdersByDate = {};

    // Get today's date in 'YYYY-MM-DD' format
    const todayDate = new Date().toISOString().split('T')[0];

    // Calculate the date one week back from today
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // Process EOM rows
    parsedEomData.forEach(eomRow => {
        // Extract from each EOM row
        const orderDateParts = eomRow['Order Date'].split('/');
        const orderDate = new Date(orderDateParts[2], orderDateParts[0] - 1, orderDateParts[1]).toISOString().split('T')[0];        
        
        const eomOrderNumber = eomRow['Order Number'];
        const eomUpc = eomRow['Upc'];
        console.log(eomUpc);
        const eomProductOptionValue = eomRow['Product Option Value'];
        
        // Find the corresponding Radial row by matching the order number and UPC
        const RadialRow = parsedRadialData.find(RadialRow => {
            const orderNumber = RadialRow['Client Web Order Number (Alternative)'];
            const radialUpc = RadialRow['Item UPC'];

            // Check if orderNumber and radialUpc are defined
            if (orderNumber && radialUpc) {
                // Compare both the order number (after removing the prefix) and the UPC
                return orderNumber.substring(5) === eomOrderNumber && radialUpc === eomUpc;
            }

            return false; // If either orderNumber or radialUpc is undefined, return false
        });
        
        // Check for missing orders and exclude today's date
        const orderExistsInRadialData = RadialRow !== undefined;
        if (!orderExistsInRadialData && orderDate !== todayDate) {
            if (!missingOrdersByDate[orderDate]) {
                missingOrdersByDate[orderDate] = [];
            }
            missingOrdersByDate[orderDate].push({ orderNumber: eomOrderNumber, productOptionValue: eomProductOptionValue });
        }      
    });
       
    // Create the summary object
    const summary = {
        missingOrdersByDate,
        OrdersMissing: Object.values(missingOrdersByDate).reduce((acc, orders) => acc + orders.length, 0),
    };
    console.log(summary);

    // Store the report data in the database
    const reportDate = new Date().toISOString();
    const stmt = db.prepare("INSERT INTO archive (date, response, missing_orders_count, aging_orders_count, uncanceled_orders_count) VALUES (?, ?, ?, ?, ?)");
    stmt.run(reportDate, JSON.stringify(summary), summary.OrdersMissing, summary.OrdersAging, summary.OrdersUncancelled , function(err) {
        if (err) {
            res.status(500).send("Error storing report data");
            return;
        }
        // Use the stored date for the report
        const reportId = this.lastID;
        // Redirect to the specific report page using the report ID
        res.redirect(`/report/${reportId}`);
    });
    stmt.finalize();
});

// Route to retrieve and display a report by ID
app.get('/report/:id', (req, res) => {
    const reportId = req.params.id;
    db.get("SELECT * FROM archive WHERE id = ?", reportId, (err, row) => {
        if (err) {
            res.status(500).send("Error retrieving report");
            return;
        }
        if (!row) {
            res.status(404).send("Report not found");
            return;
        }

        const reportData = JSON.parse(row.response);
        res.render('report', { 
            reportId: reportId, 
            reportData: reportData, 
            reportDate: row.date, 
            formatEST: formatEST 
        });
    });
});


// Route to get report overview 
app.get('/report', (req, res) => {
    db.all("SELECT id, date, response FROM archive ORDER BY date DESC", [], (err, rows) => {
        if (err) {
            res.status(500).send("Error retrieving reports");
            return;
        }
        res.render('reportList', { 
            rows: rows, 
            formatEST: formatEST, 
            getExcludedCounts: getExcludedCounts // Pass the function for processing report data
        });
    });
});





// Start the server
app.listen(port, () => {
    console.log(`Server started. Go to http://localhost:${port}/upload to generate new report.`);
});
