const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { exec } = require('child_process');
const Tesseract = require('tesseract.js');
const mammoth = require('mammoth');

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const app = express();
const port = 8000;

// Serve static files
app.use(express.static(path.join(__dirname)));

// API Routes
app.post('/api/convert', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { conversionType } = req.body;
        const inputPath = req.file.path;
        const outputFilename = path.basename(inputPath, path.extname(inputPath));
        let outputPath, command;

        switch (conversionType) {
            case 'word-to-pdf':
                outputPath = path.join(uploadDir, `${outputFilename}.pdf`);
                await convertWordToPdf(inputPath, outputPath);
                break;

            case 'pdf-to-word':
                outputPath = path.join(uploadDir, `${outputFilename}.docx`);
                await convertPdfToWord(inputPath, outputPath);
                break;

            case 'image-to-pdf':
                outputPath = path.join(uploadDir, `${outputFilename}.pdf`);
                await convertImageToPdf(inputPath, outputPath);
                break;

            case 'pdf-to-image':
                outputPath = path.join(uploadDir, `${outputFilename}.jpg`);
                await convertPdfToImage(inputPath, outputPath);
                break;

            default:
                return res.status(400).json({ error: 'Invalid conversion type' });
        }

        // Send the converted file
        res.download(outputPath, () => {
            // Clean up files after download
            setTimeout(() => {
                fs.unlinkSync(inputPath);
                fs.unlinkSync(outputPath);
            }, 5000);
        });

    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: 'Conversion failed', details: error.message });
    }
});

app.post('/api/ocr', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Validate file type
        const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!validTypes.includes(req.file.mimetype)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ 
                error: 'Invalid file type',
                details: 'Only JPEG, PNG, and PDF files are supported'
            });
        }

        console.log(`Processing OCR for: ${req.file.originalname}`);
        let filePath = req.file.path;
        
        // Convert PDF to image first if needed
        if (req.file.mimetype === 'application/pdf') {
            const pdfImagePath = await convertPdfToImage(req.file.path);
            filePath = pdfImagePath;
        }

        const result = await Tesseract.recognize(
            filePath,
            'eng',
            { 
                logger: m => console.log(m.status),
                errorHandler: err => console.error('OCR Engine Error:', err)
            }
        );

        // Clean up temporary files
        if (filePath !== req.file.path) {
            fs.unlinkSync(filePath);
        }

        // Clean up the uploaded file
        fs.unlinkSync(req.file.path);

        if (!result.data?.text || result.data.text.trim().length === 0) {
            return res.status(400).json({ 
                error: 'No text found',
                details: 'The document appears to have no readable text'
            });
        }

        res.json({ 
            text: result.data.text,
            filename: req.file.originalname,
            pages: result.data?.pages || 1,
            confidence: result.data?.confidence,
            hocr: result.data?.hocr
        });

    } catch (error) {
        console.error('OCR processing error:', error);
        if (req.file?.path) {
            fs.unlinkSync(req.file.path).catch(e => console.error('Cleanup error:', e));
        }
        
        let errorMessage = 'OCR processing failed';
        let suggestion = 'Try a clearer image or different document';
        
        if (error.message.includes('Pdf reading is not supported')) {
            errorMessage = 'PDF processing failed';
            suggestion = 'The server failed to process this PDF. Try converting it to an image first.';
        }

        res.status(500).json({ 
            error: errorMessage,
            details: error.message,
            suggestion: suggestion
        });
    }
});

// Conversion functions
async function convertWordToPdf(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        exec(`libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${path.dirname(outputPath)}"`, 
            (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            }
        );
    });
}

async function convertPdfToWord(inputPath, outputPath) {
    // This is a simplified approach - in production you might use a more robust solution
    const pdfDoc = await PDFDocument.load(fs.readFileSync(inputPath));
    const text = (await pdfDoc.getPages())[0].getText();
    
    const result = await mammoth.extractRawText({ buffer: Buffer.from(text) });
    fs.writeFileSync(outputPath, result.value);
}

async function convertImageToPdf(inputPath, outputPath) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]); // Letter size
    
    // For simplicity, we're just adding the image path as text
    // In a real app, you would embed the actual image
    page.drawText(`Image: ${path.basename(inputPath)}`, {
        x: 50,
        y: 700,
        size: 12,
    });
    
    fs.writeFileSync(outputPath, await pdfDoc.save());
}

async function convertPdfToImage(inputPath, outputPath) {
    // This is a simplified approach - in production you might use something like Ghostscript
    const pdfDoc = await PDFDocument.load(fs.readFileSync(inputPath));
    const page = pdfDoc.getPages()[0];
    
    // For simplicity, we're just creating a blank image with the PDF info
    // In a real app, you would render the actual PDF page to an image
    const canvas = require('canvas').createCanvas(600, 800);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = 'black';
    ctx.font = '20px Arial';
    ctx.fillText(`PDF: ${path.basename(inputPath)}`, 50, 50);
    
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createJPEGStream();
    stream.pipe(out);
    
    return new Promise(resolve => out.on('finish', resolve));
}

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});