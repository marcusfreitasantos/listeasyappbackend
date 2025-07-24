import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";
import * as corsLib from "cors";

admin.initializeApp();
const cors = corsLib.default({ origin: true });

interface ExpandedInvoice extends Stripe.Invoice {
  payment_intent: Stripe.PaymentIntent;
}

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

// POST /createSubscriptionPaymentSheet - Create a subscription based on the product
// OBS:  The user must have a default payment method set up in Stripe
export const createSubscriptionPaymentSheet = functions.https.onRequest(
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
        // 1. Create ephemeral key
        const ephemeralKey = await stripe.ephemeralKeys.create(
          { customer: customerId },
          { apiVersion: "2023-10-16" }
        );

        // 2. Create subscription
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          payment_settings: {
            payment_method_types: ["card"],
            save_default_payment_method: "on_subscription",
          },
          expand: ["latest_invoice.payment_intent"],
        });

        const latestInvoice = subscription.latest_invoice;

        if (typeof latestInvoice === "string") {
          return res.status(500).send("Unexpected invoice format");
        }

        const paymentIntent = (latestInvoice as ExpandedInvoice).payment_intent;

        return res.status(200).json({
          clientSecret: paymentIntent.client_secret,
          ephemeralKey: ephemeralKey.secret,
          customerId: customerId,
          subscriptionId: subscription.id,
        });
      } catch (error) {
        console.error("Error creating subscription:", error);
        return res.status(500).send("Internal Server Error");
      }
    });
  }
);
