/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Define the shape of the environment variables (for TypeScript, if used later)
// For JS, this serves as a mental note of what `env` should contain.
// interface Env {
//   NEYNAR_API_KEY: string;
// }

const app = new Hono();

// Setup CORS middleware to allow requests from your frontend
// Adjust origin as necessary, e.g., to your localhost for development or your deployed frontend URL
app.use('/api/*', cors()); 

app.get('/', (c) => {
	return c.text('Hello from Hono on Cloudflare Workers!');
});

app.get('/api/search-users', async (c) => {
	const { NEYNAR_API_KEY } = c.env;
	if (!NEYNAR_API_KEY) {
		return c.json({ error: 'Neynar API key not configured' }, 500);
	}

	const query = c.req.query('q');
	if (!query) {
		return c.json({ error: 'Search query \'q\' is required' }, 400);
	}

	const neynarApiUrl = `https://api.neynar.com/v2/farcaster/user/search?q=${encodeURIComponent(query)}&limit=5`;

	try {
		const response = await fetch(neynarApiUrl, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'api_key': NEYNAR_API_KEY, // Corrected header name based on typical Neynar usage
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`Neynar API error: ${response.status} ${response.statusText}`, errorText);
			return c.json({ error: 'Failed to fetch data from Neynar API', details: errorText }, response.status);
		}

		const neynarData = await response.json();
		
		// Transform the data to the desired format
		const users = neynarData.result.users.map(user => {
			// Extract primary SOL address, default to null if not found
			const primarySolAddress = user.verified_addresses?.primary?.sol_address || null;
			
			return {
				fid: user.fid,
				username: user.username,
				display_name: user.display_name,
				pfp_url: user.pfp_url,
				primary_sol_address: primarySolAddress, // This will be our edPubTarget
			};
		});

		return c.json({ users });

	} catch (error) {
		console.error('Error in /api/search-users:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

export default app;
