import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import Stripe from "stripe";
const stripe = new Stripe( functions.config().
    someservice.stripe_secret_key as string, {
  apiVersion: "2020-08-27"}
);

admin.initializeApp();

// Create a customer object in Stripe when a user is created.

export const createCustomer = functions.auth.user().onCreate(async (user) => {
  const {email, displayName, uid} = user;
  // create a customer
  const customer = await stripe.customers.create({
    email: email,
    name: displayName,
    metadata: {
      firebaseUID: uid,
    },
  });
  // save stripeID in firestore
  await admin
      .firestore()
      .collection("users")
      .doc(uid)
      .set({
        stripeId: customer.id,
      }, {merge: true});
  // log
  functions.logger.info("User created!");
});

// Delete a customer.

export const deleteCustomer = functions.auth.user().onDelete(async (user) => {
  // ref
  const customerRef = admin.firestore().collection("users").doc(user.uid);
  // get stripeId
  const customer = (await customerRef.get()).data()?.stripeId;
  // set all subscriptions as cancelled in Firestore
  const update = {
    status: "canceled",
    ended_at: admin.firestore.Timestamp.now(),
  };
  const subscriptionsSnap = await customerRef
      .collection("subscriptions")
      .where("status", "in", ["trialing, active"])
      .get();
  subscriptionsSnap.forEach((doc) => {
    doc.ref.set(update, {merge: true});
  });
  // delete customer in Stripe
  await stripe.customers.del(customer);
  // log
  functions.logger.info(`User Deleted: ${customer}`);
});

const createProductRecord = async (product: Stripe.Product) => {
  const {firebaseRole} = product.metadata;
  const productData = {
    active: product.active,
    name: product.name,
    description: product.description,
    role: firebaseRole,
    images: product.images,
    metadata: product.metadata,
  };
  await admin
      .firestore()
      .collection("products")
      .doc(product.id)
      .set(productData, {merge: true});
  functions.logger.info("produto criado: " + product.id);
};

const insertPriceRecord = async (price: Stripe.Price) => {
  const priceData = {
    active: price.active,
    billing_scheme: price.billing_scheme,
    currency: price.currency,
    description: price.nickname,
    type: price.type,
    unit_amount: price.unit_amount,
    recurring: price.recurring,
    metadata: price.metadata,
    product: price.product,
  };
  const dbRef = admin
      .firestore()
      .collection("products")
      .doc(price.product as string)
      .collection("prices");
  await dbRef.doc(price.id).set(priceData, {merge: true});
  functions.logger.info("price created:" + price.id);
};

const deleteProductOrPrice = async (pr: Stripe.Product | Stripe.Price) => {
  if (pr.object === "product") {
    await admin
        .firestore()
        .collection("products")
        .doc(pr.id)
        .delete();
    functions.logger.info("product deleted: " + pr.id);
  }
  if (pr.object === "price") {
    await admin
        .firestore()
        .collection("products")
        .doc(pr.product as string)
        .collection("prices")
        .doc(pr.id)
        .delete();
    functions.logger.info("price deleted: " + pr.id);
  }
};

const manageSubscription = async (
    subscriptionId: string,
    customerId: string) => {
  const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("stripeId", "==", customerId)
      .get();
  const uid = usersSnap.docs[0].id;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["default_payment_method", "items.data.price.product"],
  });
  const price = subscription.items.data[0].price;
  const prices = [];
  for (const item of subscription.items.data) {
    prices.push(
        admin
            .firestore()
            .collection("products")
            .doc((item.price.product as Stripe.Product).id)
            .collection("prices")
            .doc(item.price.id)
    );
  }
  const product = price.product as Stripe.Product;
  const role = product.metadata.firebaseRole;
  const subsRef = usersSnap.docs[0].ref
      .collection("subscriptions")
      .doc(subscription.id);
  const subscriptionData = {
    metadata: subscription.metadata,
    role,
    status: subscription.status,
    product: admin
        .firestore()
        .collection("products")
        .doc(product.id),
    price: admin
        .firestore()
        .collection("products")
        .doc(product.id)
        .collection("prices")
        .doc(price.id),
    prices,
    items: subscription.items.data,
    cancel_at_period_end: subscription.cancel_at_period_end,
    cancel_at: subscription.cancel_at ?
    admin.firestore.Timestamp.fromMillis(subscription.cancel_at * 1000) :
    null,
    canceled_at: subscription.canceled_at ?
    admin.firestore.Timestamp.fromMillis(subscription.canceled_at * 1000) :
    null,
    current_period_start: admin.firestore.Timestamp.fromMillis(
        subscription.current_period_start * 1000
    ),
    current_period_end: admin.firestore.Timestamp.fromMillis(
        subscription.current_period_end * 1000
    ),
    created: admin.firestore.Timestamp.fromMillis(subscription.created * 1000),
    ended_at: subscription.ended_at ?
    admin.firestore.Timestamp.fromMillis(subscription.ended_at * 1000) :
    null,
  };
  await subsRef.set(subscriptionData);
  functions.logger.info("subscription: " + subscription.id);
  try {
    const {customClaims} = await admin.auth().getUser(uid);
    if ("active".includes(subscription.status)) {
      functions.logger.info(uid + " = stripeRole -> " + uid);
      await admin
          .auth()
          .setCustomUserClaims(uid, {...customClaims, stripeRole: role});
    } else {
      functions.logger.info(uid + " = stripeRole -> null");
      await admin
          .auth()
          .setCustomUserClaims(uid, {...customClaims, stripeRole: null});
    }
  } catch (error) {
    return;
  }
};

const insertInvoiceRecord = async (invoice: Stripe.Invoice) => {
  const usersSnap = await admin
      .firestore()
      .collection("users")
      .where("stripeId", "==", invoice.customer)
      .get();

  await usersSnap.docs[0].ref
      .collection("subscriptions")
      .doc(invoice.subscription as string)
      .collection("invoices")
      .doc(invoice.id)
      .set(invoice);
  functions.logger.info("invoices: " + invoice.id);
};

export const handleWebhookEvents = functions.https.onRequest(
    async (req, res) => {
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
            req.rawBody,
            req.headers["stripe-signature"] as string | string[],
            functions.config().someservice.endpoint_secret
        );
        switch (event.type) {
          case "product.created":
          case "product.updated":
            await createProductRecord(event.data.object as Stripe.Product);
            break;
          case "price.created":
          case "price.updated":
            await insertPriceRecord(event.data.object as Stripe.Price);
            break;
          case "produt.deleted":
            await deleteProductOrPrice(event.data.object as Stripe.Product);
            break;
          case "price.deleted":
            await deleteProductOrPrice(event.data.object as Stripe.Price);
            break;
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const subscription = event.data.object as Stripe.Subscription;
            await manageSubscription(
                subscription.id,
                subscription.customer as string,
            );
          }
            break;
          case "invoice.paid":
          case "invoice.payment_succeeded":
          case "invoice.payment_failed":
          case "invoice.upcoming":
          case "invoice.marked_uncollectible":
          case "invoice.payment_action_required":
            await insertInvoiceRecord(event.data.object as Stripe.Invoice);
            break;
          default:
            functions.logger.info(`error: ${event.id}, ${event.type}`);
        }
        functions.logger.info(`sucess: ${event.id}, ${event.type}`);
        res.send({event});
      } catch (error) {
        res.send({error});
      }
      res.send({received: true});
    }
);
