const express = require('express');
const cors = require('cors');
const { admin, db, auth } = require('../lib/firebase');
const { getPagination, isValidEmail, createSlug, formatMovie } = require('../lib/utils');

const app = express();

// ==================== CORS CONFIGURATION - FIXED ====================
const allowedOrigins = [
    'http://moonmovieshub.free.nf',
    'https://moonmovieshub.free.nf',
    'http://localhost',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'http://localhost:5000'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    credentials: true,
    optionsSuccessStatus: 200,
    preflightContinue: false,
    maxAge: 86400 // 24 hours
}));

// Handle preflight requests explicitly
app.options('*', cors());

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware (optional)
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Moon Movies Hub API is running',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ==================== PUBLIC ROUTES ====================

// Get all categories (ordered)
app.get('/api/categories', async (req, res) => {
    try {
        const categoriesSnapshot = await db.collection('categories')
            .orderBy('order', 'asc')
            .get();
        
        const categories = [];
        categoriesSnapshot.forEach(doc => {
            categories.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        res.json({ success: true, categories });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

// Get latest movies (with pagination)
app.get('/api/movies/latest', async (req, res) => {
    try {
        const { page, limit } = getPagination(req.query.page, req.query.limit);
        
        const moviesSnapshot = await db.collection('movies')
            .where('type', '==', 'movie')
            .orderBy('addedAt', 'desc')
            .limit(limit)
            .offset((page - 1) * limit)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            movies.push(formatMovie(doc));
        });
        
        // Get total count for pagination
        const totalSnapshot = await db.collection('movies')
            .where('type', '==', 'movie')
            .count()
            .get();
        const total = totalSnapshot.data().count;
        
        res.json({
            success: true,
            movies,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalMovies: total,
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1
            }
        });
    } catch (error) {
        console.error('Error fetching latest movies:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch movies' });
    }
});

// Get movies by category
app.get('/api/category/:slug/movies', async (req, res) => {
    try {
        const { slug } = req.params;
        const { page, limit } = getPagination(req.query.page, req.query.limit);
        
        // First get category by slug
        const categorySnapshot = await db.collection('categories')
            .where('slug', '==', slug)
            .limit(1)
            .get();
        
        if (categorySnapshot.empty) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        
        const categoryDoc = categorySnapshot.docs[0];
        const categoryId = categoryDoc.id;
        
        // Get movies in this category
        const moviesSnapshot = await db.collection('movies')
            .where('categoryId', '==', categoryId)
            .orderBy('addedAt', 'desc')
            .limit(limit)
            .offset((page - 1) * limit)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            movies.push(formatMovie(doc));
        });
        
        // Get total count
        const totalSnapshot = await db.collection('movies')
            .where('categoryId', '==', categoryId)
            .count()
            .get();
        const total = totalSnapshot.data().count;
        
        res.json({
            success: true,
            category: {
                id: categoryId,
                ...categoryDoc.data()
            },
            movies,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalMovies: total,
                hasNext: page < Math.ceil(total / limit),
                hasPrev: page > 1
            }
        });
    } catch (error) {
        console.error('Error fetching category movies:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch category movies' });
    }
});

// Get single movie by ID
app.get('/api/movie/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const movieDoc = await db.collection('movies').doc(id).get();
        
        if (!movieDoc.exists) {
            return res.status(404).json({ success: false, error: 'Movie not found' });
        }
        
        const movie = formatMovie(movieDoc);
        
        // Get category info
        if (movie.categoryId) {
            const categoryDoc = await db.collection('categories').doc(movie.categoryId).get();
            if (categoryDoc.exists) {
                movie.category = categoryDoc.data();
            }
        }
        
        res.json({ success: true, movie });
    } catch (error) {
        console.error('Error fetching movie:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch movie' });
    }
});

// Search movies by title
app.get('/api/search', async (req, res) => {
    try {
        const { q, page, limit } = req.query;
        
        if (!q || q.trim() === '') {
            return res.status(400).json({ success: false, error: 'Search query is required' });
        }
        
        const { page: pageNum, limit: limitNum } = getPagination(page, limit);
        
        // Firebase doesn't support native text search, so we'll do a simple startsWith
        // For better search, consider using Algolia or MeiliSearch
        const searchTerm = q.toLowerCase();
        
        const moviesSnapshot = await db.collection('movies')
            .orderBy('title')
            .startAt(searchTerm)
            .endAt(searchTerm + '\uf8ff')
            .limit(limitNum)
            .offset((pageNum - 1) * limitNum)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            movies.push(formatMovie(doc));
        });
        
        res.json({
            success: true,
            query: q,
            movies,
            pagination: {
                currentPage: pageNum,
                limit: limitNum,
                totalResults: movies.length
            }
        });
    } catch (error) {
        console.error('Error searching movies:', error);
        res.status(500).json({ success: false, error: 'Failed to search movies' });
    }
});

// ==================== ADMIN ROUTES ====================

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        console.log('Login attempt for:', email); // Debug log
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password required' });
        }
        
        // Get admin from Firestore
        const adminSnapshot = await db.collection('settings')
            .where('email', '==', email)
            .limit(1)
            .get();
        
        if (adminSnapshot.empty) {
            console.log('No admin found with email:', email);
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        
        const adminData = adminSnapshot.docs[0].data();
        
        // Simple password check (in production, use proper hashing)
        if (adminData.password !== password) {
            console.log('Password mismatch for:', email);
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        
        // Generate simple token
        const token = Buffer.from(`${email}-${Date.now()}`).toString('base64');
        
        // Store token in Firestore (optional)
        await db.collection('settings').doc(adminSnapshot.docs[0].id).update({
            lastLogin: new Date(),
            currentToken: token
        });
        
        console.log('Login successful for:', email);
        
        res.json({
            success: true,
            message: 'Login successful',
            token,
            admin: {
                email: adminData.email
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed: ' + error.message });
    }
});

// Middleware to verify admin token
const verifyAdminToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }
        
        // Verify token from Firestore
        const adminSnapshot = await db.collection('settings')
            .where('currentToken', '==', token)
            .limit(1)
            .get();
        
        if (adminSnapshot.empty) {
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }
        
        req.admin = adminSnapshot.docs[0].data();
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        res.status(500).json({ success: false, error: 'Authentication failed' });
    }
};

// Get all movies (admin)
app.get('/api/admin/movies', verifyAdminToken, async (req, res) => {
    try {
        const { page, limit } = getPagination(req.query.page, 50); // Admin can see more
        
        const moviesSnapshot = await db.collection('movies')
            .orderBy('addedAt', 'desc')
            .limit(limit)
            .offset((page - 1) * limit)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            movies.push(formatMovie(doc));
        });
        
        res.json({ success: true, movies });
    } catch (error) {
        console.error('Error fetching admin movies:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch movies' });
    }
});

// Add new movie
app.post('/api/admin/movies', verifyAdminToken, async (req, res) => {
    try {
        const movieData = req.body;
        
        // Validate required fields
        if (!movieData.title || !movieData.categoryId) {
            return res.status(400).json({ success: false, error: 'Title and category are required' });
        }
        
        // Prepare movie data
        const newMovie = {
            title: movieData.title,
            poster: movieData.poster || '',
            description: movieData.description || '',
            categoryId: movieData.categoryId,
            type: movieData.type || 'movie', // 'movie' or 'series'
            downloads: movieData.downloads || [],
            screenshots: movieData.screenshots || [],
            addedAt: new Date(),
            updatedAt: new Date()
        };
        
        // If series, add seasons data
        if (movieData.type === 'series' && movieData.seasons) {
            newMovie.seasons = movieData.seasons;
        }
        
        const docRef = await db.collection('movies').add(newMovie);
        
        res.json({
            success: true,
            message: 'Movie added successfully',
            movieId: docRef.id
        });
    } catch (error) {
        console.error('Error adding movie:', error);
        res.status(500).json({ success: false, error: 'Failed to add movie' });
    }
});

// Update movie
app.put('/api/admin/movies/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        updates.updatedAt = new Date();
        
        await db.collection('movies').doc(id).update(updates);
        
        res.json({ success: true, message: 'Movie updated successfully' });
    } catch (error) {
        console.error('Error updating movie:', error);
        res.status(500).json({ success: false, error: 'Failed to update movie' });
    }
});

// Delete movie
app.delete('/api/admin/movies/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        await db.collection('movies').doc(id).delete();
        
        res.json({ success: true, message: 'Movie deleted successfully' });
    } catch (error) {
        console.error('Error deleting movie:', error);
        res.status(500).json({ success: false, error: 'Failed to delete movie' });
    }
});

// Category management

// Add category
app.post('/api/admin/categories', verifyAdminToken, async (req, res) => {
    try {
        const { name, order } = req.body;
        
        if (!name) {
            return res.status(400).json({ success: false, error: 'Category name is required' });
        }
        
        const slug = createSlug(name);
        
        const newCategory = {
            name,
            slug,
            order: order || 0,
            createdAt: new Date()
        };
        
        const docRef = await db.collection('categories').add(newCategory);
        
        res.json({
            success: true,
            message: 'Category added successfully',
            categoryId: docRef.id
        });
    } catch (error) {
        console.error('Error adding category:', error);
        res.status(500).json({ success: false, error: 'Failed to add category' });
    }
});

// Update category
app.put('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        if (updates.name) {
            updates.slug = createSlug(updates.name);
        }
        
        await db.collection('categories').doc(id).update(updates);
        
        res.json({ success: true, message: 'Category updated successfully' });
    } catch (error) {
        console.error('Error updating category:', error);
        res.status(500).json({ success: false, error: 'Failed to update category' });
    }
});

// Delete category
app.delete('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if category has movies
        const moviesSnapshot = await db.collection('movies')
            .where('categoryId', '==', id)
            .limit(1)
            .get();
        
        if (!moviesSnapshot.empty) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete category with movies. Move or delete movies first.'
            });
        }
        
        await db.collection('categories').doc(id).delete();
        
        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        console.error('Error deleting category:', error);
        res.status(500).json({ success: false, error: 'Failed to delete category' });
    }
});

// Get all categories (admin)
app.get('/api/admin/categories', verifyAdminToken, async (req, res) => {
    try {
        const categoriesSnapshot = await db.collection('categories')
            .orderBy('order', 'asc')
            .get();
        
        const categories = [];
        categoriesSnapshot.forEach(doc => {
            categories.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        res.json({ success: true, categories });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

// ==================== TEST ROUTE FOR CORS ====================
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'CORS is working!',
        origin: req.headers.origin || 'No origin',
        timestamp: new Date().toISOString()
    });
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error: ' + err.message });
});

// Export for Vercel
module.exports = app;
