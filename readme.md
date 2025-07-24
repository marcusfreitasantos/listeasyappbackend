# ListEasy Firebase Functions Backend

This project contains the backend serverless functions for the ListEasy app, implemented using [Firebase Cloud Functions](https://firebase.google.com/docs/functions) and [TypeScript](https://www.typescriptlang.org/). The backend integrates with [Stripe](https://stripe.com/) for subscription management and payment processing.

## Project Structure

- `functions/` - Source code for Firebase Cloud Functions
  - `src/` - TypeScript source files
  - `lib/` - Compiled JavaScript output
  - `.env` - Environment variables (not committed to version control)
  - `package.json` - Dependencies and scripts
  - `tsconfig.json` - TypeScript configuration

## Main Dependencies

- **firebase-functions**: Firebase Cloud Functions SDK for defining HTTP endpoints.
- **firebase-admin**: Firebase Admin SDK for server-side Firebase features.
- **stripe**: Stripe Node.js SDK for payment and subscription management.
- **cors**: Middleware for enabling Cross-Origin Resource Sharing.
- **dotenv**: Loads environment variables from `.env` (used for local development).
- **@typescript-eslint**: Linting support for TypeScript.
- **eslint**: Linter for code quality and style.

## Environment Variables

The following variables are required in `functions/.env`:

- `STRIPE_BASE_URL` - Stripe API base URL
- `STRIPE_API_PUBLIC_KEY_TEST` - Stripe public API key (test)
- `STRIPE_API_SECRET_KEY_TEST` - Stripe secret API key (test)

## Cloud Functions

### 1. `createStripeCustomer`

**Endpoint:** `POST /createStripeCustomer`

Creates a new Stripe customer using the provided email and name. If a customer with the given email already exists, returns the existing customer.

**Request Body:**

```json
{
  "email": "user@example.com",
  "name": "User Name"
}
```

**Response:**

- 200: Customer created or already exists (returns customer info)
- 400: Missing email or name
- 405: Method not allowed
- 500: Internal server error

---

### 2. `getProducts`

**Endpoint:** `GET /getProducts`

Lists all active Stripe products and their associated prices.

**Response:**

- 200: Array of products with fields: `productId`, `name`, `priceId`, `amount`, `currency`, `interval`
- 500: Internal server error

---

### 3. `createSubscriptionPaymentSheet`

**Endpoint:** `POST /createSubscriptionPaymentSheet`

Creates a Stripe subscription for a customer and returns the necessary information for the client to complete payment using Stripe's Payment Sheet.

**Request Body:**

```json
{
  "customerId": "cus_123",
  "priceId": "price_123"
}
```

**Response:**

- 200: Returns `clientSecret`, `ephemeralKey`, `customerId`, `subscriptionId`
- 400: Missing customer or priceId
- 405: Method not allowed
- 500: Internal server error

---

## Development

### Install dependencies

```sh
cd functions
npm install
```

### Build TypeScript

```sh
npm run build
```

### Lint

```sh
npm run lint
```

### Serve locally

```sh
npm run serve
```

## Deployment

Deploy functions to Firebase:

```sh
npm run deploy
```

---

## License

This project is private and not licensed for redistribution.
