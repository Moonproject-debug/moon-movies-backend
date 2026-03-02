const express = require('express');
const cors = require('cors');
const { admin, db, auth } = require('../lib/firebase');
const { getPagination, isValidEmail, createSlug, formatMovie } = require('../lib/utils');

const app = express();

// ==================== CORS CONFIGURATION ====================
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
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy does not allow access from this origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ==================== LOGGING MIDDLEWARE ====================
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'API is running', timestamp: new Date().toISOString() });
});

// ==================== DEBUG ENDPOINTS ====================

// Debug: Check Firestore connection and movies
app.get('/api/debug/movies', async (req, res) => {
    try {
        console.log('Debug: Checking movies collection');
        
        // Check if db is initialized
        if (!db) {
            return res.status(500).json({ error: 'Firestore not initialized' });
        }
        
        // Try to get a single movie
        const snapshot = await db.collection('movies').limit(1).get();
        
        const movies = [];
        snapshot.forEach(doc => {
            movies.push({
                id: doc.id,
                ...doc.data(),
                _debug: {
                    hasAddedAt: !!doc.data().addedAt,
                    addedAtType: doc.data().addedAt ? typeof doc.data().addedAt : null,
                    isTimestamp: doc.data().addedAt && doc.data().addedAt.toDate ? true : false
                }
            });
        });
        
        // Get total count
        const countSnapshot = await db.collection('movies').count().get();
        const total = countSnapshot.data().count;
        
        res.json({
            success: true,
            message: 'Firestore connection OK',
            totalMovies: total,
            sampleMovies: movies,
            dbInitialized: true
        });
    } catch (error) {
        console.error('Debug endpoint error:', error);
        res.status(500).json({
            error: error.message,
            stack: error.stack,
            name: error.name
        });
    }
});

// Debug: Create test movie (if none exist)
app.get('/api/debug/create-test-movie', async (req, res) => {
    try {
        // First check if we have any categories
        const categoriesSnapshot = await db.collection('categories').limit(1).get();
        
        if (categoriesSnapshot.empty) {
            return res.status(400).json({ 
                error: 'No categories found. Please create a category first.' 
            });
        }
        
        const firstCategory = categoriesSnapshot.docs[0];
        
        // Create test movie
        const testMovie = {
            title: 'Test Movie ' + new Date().toLocaleDateString(),
            poster: '',
            description: 'This is a test movie created by debug endpoint',
            categoryId: firstCategory.id,
            type: 'movie',
            downloads: [
                { quality: '720p', link: 'https://example.com/test1' },
                { quality: '1080p', link: 'https://example.com/test2' }
            ],
            screenshots: [],
            addedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        const docRef = await db.collection('movies').add(testMovie);
        
        res.json({
            success: true,
            message: 'Test movie created',
            movieId: docRef.id,
            category: {
                id: firstCategory.id,
                name: firstCategory.data().name
            }
        });
    } catch (error) {
        console.error('Error creating test movie:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== PUBLIC ROUTES (FIXED) ====================

// Get all categories
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get latest movies - FIXED VERSION with better error handling
app.get('/api/movies/latest', async (req, res) => {
    try {
        const { page, limit } = getPagination(req.query.page, req.query.limit);
        
        console.log(`Fetching movies: page=${page}, limit=${limit}`);
        
        // First check if movies collection exists and has data
        const countCheck = await db.collection('movies').count().get();
        const totalMovies = countCheck.data().count;
        
        console.log(`Total movies in database: ${totalMovies}`);
        
        if (totalMovies === 0) {
            return res.json({
                success: true,
                movies: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalMovies: 0,
                    hasNext: false,
                    hasPrev: false
                },
                message: 'No movies found in database'
            });
        }
        
        // Try to get movies without filter first (to debug)
        const allMoviesSnapshot = await db.collection('movies')
            .limit(1)
            .get();
        
        console.log('Sample movie fields:', allMoviesSnapshot.docs[0]?.data() ? Object.keys(allMoviesSnapshot.docs[0].data()) : 'No movies');
        
        // Now get paginated movies
        let moviesQuery = db.collection('movies')
            .orderBy('addedAt', 'desc')
            .limit(limit)
            .offset((page - 1) * limit);
        
        const moviesSnapshot = await moviesQuery.get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            const data = doc.data();
            // Format the movie properly
            movies.push({
                id: doc.id,
                title: data.title || 'Untitled',
                poster: data.poster || '',
                description: data.description || '',
                categoryId: data.categoryId || '',
                type: data.type || 'movie',
                downloads: data.downloads || [],
                screenshots: data.screenshots || [],
                addedAt: data.addedAt ? (data.addedAt.toDate ? data.addedAt.toDate() : new Date(data.addedAt)) : new Date(),
                updatedAt: data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate() : new Date(data.updatedAt)) : new Date()
            });
        });
        
        console.log(`Returning ${movies.length} movies`);
        
        res.json({
            success: true,
            movies,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(totalMovies / limit),
                totalMovies,
                hasNext: page < Math.ceil(totalMovies / limit),
                hasPrev: page > 1
            }
        });
    } catch (error) {
        console.error('Error in /api/movies/latest:', error);
        
        // Detailed error response
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: {
                name: error.name,
                code: error.code,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            }
        });
    }
});

// Get movies by category - FIXED VERSION
app.get('/api/category/:slug/movies', async (req, res) => {
    try {
        const { slug } = req.params;
        const { page, limit } = getPagination(req.query.page, req.query.limit);
        
        // Get category by slug
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
            const data = doc.data();
            movies.push({
                id: doc.id,
                title: data.title || 'Untitled',
                poster: data.poster || '',
                description: data.description || '',
                categoryId: data.categoryId,
                type: data.type || 'movie',
                downloads: data.downloads || [],
                screenshots: data.screenshots || [],
                addedAt: data.addedAt ? (data.addedAt.toDate ? data.addedAt.toDate() : new Date(data.addedAt)) : new Date()
            });
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
        res.status(500).json({ success: false, error: error.message });
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
        
        const data = movieDoc.data();
        const movie = {
            id: movieDoc.id,
            title: data.title || 'Untitled',
            poster: data.poster || '',
            description: data.description || '',
            categoryId: data.categoryId,
            type: data.type || 'movie',
            downloads: data.downloads || [],
            screenshots: data.screenshots || [],
            addedAt: data.addedAt ? (data.addedAt.toDate ? data.addedAt.toDate() : new Date(data.addedAt)) : new Date()
        };
        
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// Search movies
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.trim() === '') {
            return res.status(400).json({ success: false, error: 'Search query required' });
        }
        
        const searchTerm = q.toLowerCase();
        
        const moviesSnapshot = await db.collection('movies')
            .orderBy('title')
            .startAt(searchTerm)
            .endAt(searchTerm + '\uf8ff')
            .limit(20)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            const data = doc.data();
            movies.push({
                id: doc.id,
                title: data.title,
                poster: data.poster || '',
                categoryId: data.categoryId,
                type: data.type || 'movie'
            });
        });
        
        res.json({ success: true, query: q, movies });
    } catch (error) {
        console.error('Error searching:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== ADMIN ROUTES ====================

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password required' });
        }
        
        const adminSnapshot = await db.collection('settings')
            .where('email', '==', email)
            .limit(1)
            .get();
        
        if (adminSnapshot.empty) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        
        const adminData = adminSnapshot.docs[0].data();
        
        if (adminData.password !== password) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        
        const token = Buffer.from(`${email}-${Date.now()}`).toString('base64');
        
        await db.collection('settings').doc(adminSnapshot.docs[0].id).update({
            lastLogin: new Date(),
            currentToken: token
        });
        
        res.json({
            success: true,
            token,
            admin: { email: adminData.email }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin token verification middleware
const verifyAdminToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ success: false, error: 'No token provided' });
        }
        
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
        res.status(500).json({ success: false, error: error.message });
    }
};

// Get all movies (admin)
app.get('/api/admin/movies', verifyAdminToken, async (req, res) => {
    try {
        const { page, limit } = getPagination(req.query.page, 50);
        
        const moviesSnapshot = await db.collection('movies')
            .orderBy('addedAt', 'desc')
            .limit(limit)
            .offset((page - 1) * limit)
            .get();
        
        const movies = [];
        moviesSnapshot.forEach(doc => {
            const data = doc.data();
            movies.push({
                id: doc.id,
                ...data,
                addedAt: data.addedAt ? (data.addedAt.toDate ? data.addedAt.toDate() : new Date(data.addedAt)) : new Date()
            });
        });
        
        res.json({ success: true, movies });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add new movie
app.post('/api/admin/movies', verifyAdminToken, async (req, res) => {
    try {
        const movieData = req.body;
        
        if (!movieData.title || !movieData.categoryId) {
            return res.status(400).json({ success: false, error: 'Title and category required' });
        }
        
        const newMovie = {
            title: movieData.title,
            poster: movieData.poster || '',
            description: movieData.description || '',
            categoryId: movieData.categoryId,
            type: movieData.type || 'movie',
            downloads: movieData.downloads || [],
            screenshots: movieData.screenshots || [],
            addedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        if (movieData.type === 'series' && movieData.seasons) {
            newMovie.seasons = movieData.seasons;
        }
        
        const docRef = await db.collection('movies').add(newMovie);
        
        res.json({ success: true, message: 'Movie added', movieId: docRef.id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update movie
app.put('/api/admin/movies/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        
        await db.collection('movies').doc(id).update(updates);
        
        res.json({ success: true, message: 'Movie updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete movie
app.delete('/api/admin/movies/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('movies').doc(id).delete();
        res.json({ success: true, message: 'Movie deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Category management
app.post('/api/admin/categories', verifyAdminToken, async (req, res) => {
    try {
        const { name, order } = req.body;
        
        if (!name) {
            return res.status(400).json({ success: false, error: 'Category name required' });
        }
        
        const slug = createSlug(name);
        
        const newCategory = {
            name,
            slug,
            order: order || 0,
            createdAt: new Date()
        };
        
        const docRef = await db.collection('categories').add(newCategory);
        
        res.json({ success: true, message: 'Category added', categoryId: docRef.id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        if (updates.name) {
            updates.slug = createSlug(updates.name);
        }
        
        await db.collection('categories').doc(id).update(updates);
        res.json({ success: true, message: 'Category updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/admin/categories/:id', verifyAdminToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const moviesSnapshot = await db.collection('movies')
            .where('categoryId', '==', id)
            .limit(1)
            .get();
        
        if (!moviesSnapshot.empty) {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete category with movies'
            });
        }
        
        await db.collection('categories').doc(id).delete();
        res.json({ success: true, message: 'Category deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/admin/categories', verifyAdminToken, async (req, res) => {
    try {
        const categoriesSnapshot = await db.collection('categories')
            .orderBy('order', 'asc')
            .get();
        
        const categories = [];
        categoriesSnapshot.forEach(doc => {
            categories.push({ id: doc.id, ...doc.data() });
        });
        
        res.json({ success: true, categories });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        success: false, 
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

module.exports = app;
