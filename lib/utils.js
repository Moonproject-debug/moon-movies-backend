// Helper functions

// Pagination helper
const getPagination = (page, limit = 20) => {
  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || 20;
  const offset = (pageNum - 1) * limitNum;
  
  return {
    page: pageNum,
    limit: limitNum,
    offset,
    startAt: offset,
    endAt: offset + limitNum - 1
  };
};

// Validate email format
const isValidEmail = (email) => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

// Create slug from text
const createSlug = (text) => {
  return text
    .toLowerCase()
    .replace(/[^\w ]+/g, '')
    .replace(/ +/g, '-');
};

// Format movie data for response
const formatMovie = (doc) => {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    addedAt: data.addedAt ? data.addedAt.toDate() : null
  };
};

module.exports = {
  getPagination,
  isValidEmail,
  createSlug,
  formatMovie
};
