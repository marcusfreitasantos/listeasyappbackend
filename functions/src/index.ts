import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import * as corsLib from "cors";

admin.initializeApp();
const cors = corsLib.default({ origin: true });

const stripeSecret = `${process.env.STRIPE_API_SECRET_KEY_TEST}`;

const stripe = new Stripe(stripeSecret);

// 🔹 POST /createStripeCustomer - Create the customer in Stripe with e-mail and name
exports.createStripeCustomer = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const { email, name } = req.body as {
      email: string;
      name: string;
    };

    if (!email || !name) {
      return res.status(400).send("E-mail and name are required");
    }

    try {
      const existingCustomers = await stripe.customers.list({
        email,
        limit: 1,
      });

      if (existingCustomers.data.length > 0) {
        return res.status(200).json({
          message: "Customer already exists",
          stripeCustomerId: existingCustomers.data[0].id,
          stripeCustomerName: existingCustomers.data[0].name,
          stripeCustomerEmail: existingCustomers.data[0].email,
        });
      }

      const createdCustomer = await stripe.customers.create({ email, name });

      return res.status(200).json({
        message: "Customer created successfully",
        stripeCustomerId: createdCustomer.id,
        stripeCustomerName: createdCustomer.name,
        stripeCustomerEmail: createdCustomer.email,
      });
    } catch (error) {
      console.error("Error creating customer:", error);
      return res.status(500).send("Internal Server Error");
    }
  });
});

// GET /getProducts - List all active products
exports.getProducts = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const prices = await stripe.prices.list({
        active: true,
        expand: ["data.product"],
      });

      const products = prices.data.map((price) => {
        const product = price.product as Stripe.Product;

        return {
          productId: product.id,
          name: product.name,
          priceId: price.id,
          amount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval,
        };
      });

      res.status(200).json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).send("Internal Server Error");
    }
  });
});

// SETUP PAYMENT INTENT TO GET CLIENT SECRET AND SAVE CUSTOMER DEFAULT PAYMENT METHOD
exports.getClientSecret = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const { customerId } = req.body as {
      customerId: string;
    };

    try {
      const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
      });

      console.log(setupIntent);

      return res.status(200).json({
        clientSecret: setupIntent.client_secret,
      });
    } catch (error) {
      console.error("Error creating subscription:", error);
      return res.status(500).send(JSON.stringify(error));
    }
  });
});

exports.attachDefaultPaymentMethod = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const { customerId } = req.body as {
      customerId: string;
    };

    if (!customerId) {
      return res.status(400).send("customerId is required");
    }

    try {
      // List all payment methods for the customer
      const paymentMethods = await stripe.paymentMethods.list({
        customer: customerId,
        type: "card",
      });

      if (!paymentMethods.data.length) {
        throw new Error("No payment method found.");
      }

      const defaultPaymentMethod = paymentMethods.data[0].id;

      // Set it as the default for invoices/subscriptions
      await stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: defaultPaymentMethod,
        },
      });

      return res.status(200).json({
        defaultPaymentMethod,
      });
    } catch (error) {
      console.error("Error setting default payment method:", error);
      return res.status(500).send(JSON.stringify(error));
    }
  });
});

// POST /createSubscriptionPaymentSheet - Create a subscription based on the product
// OBS:  The user must have a default payment method set up in Stripe
exports.createSubscriptionPaymentSheet = functions.https.onRequest(
  (req, res) => {
    cors(req, res, async () => {
      if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
      }

      const { customerId, priceId } = req.body as {
        customerId: string;
        priceId: string;
      };

      if (!customerId || !priceId) {
        return res.status(400).send("Missing customer or priceId");
      }

      try {
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          payment_settings: {
            payment_method_types: ["card"],
            save_default_payment_method: "on_subscription",
          },
          expand: ["latest_invoice.payment_intent"],
        });

        return res.status(200).json({
          customerId: customerId,
          subscriptionId: subscription.id,
        });
      } catch (error) {
        console.error("Error creating subscription:", error);
        return res.status(500).send(JSON.stringify(error));
      }
    });
  }
);
