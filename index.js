const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);


const app = express();

const port = process.env.PORT || 5000;
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.n9sry.mongodb.net/?retryWrites=true&w=majority`;

// middlewares
app.use(cors());
app.use(express.json());


const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

const verifyJwt = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: 'forbidden access' })
    }

    req.decoded = decoded;
    next()
  })

}

const run = async () => {
  try {
    const doctorsPortalDb = client.db("doctorsPortal");
    const apptOptionsCollection = doctorsPortalDb.collection("appointmentOptions");
    const bookingsCollection = doctorsPortalDb.collection("bookings");
    const usersCollection = doctorsPortalDb.collection("users");
    const doctorsCollection = doctorsPortalDb.collection("doctors");
    const paymentsCollection = doctorsPortalDb.collection("payments");

    // use verifyAdmin after verifyJwt
    const verifyAdmin = async (req, res, next) => {
      const decodedEmail = req.decoded.email;

      const query = { email: decodedEmail }
      const user = await usersCollection.findOne(query);

      if (user?.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
      }

      next();
    }

    // use aggregate to query multiple collection and then merge data
    //! not best practice
    app.get('/appointmentOptions', async (req, res) => {
      const date = req.query.date;

      const query = {};
      const options = await apptOptionsCollection.find(query).toArray();

      // get the bookings of the provided date
      const bookingQuery = { appointmentDate: date }
      const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

      // console.log(options);
      // console.log(alreadyBooked);

      // first : for every appointment options comparing if the name of option and treatmentName in booking is similar. If similar optionBooked stores the matched booking;
      // second : from the matched bookings slots are stored as an array in bookedSlots variable;
      // third : for each option filter the slots within against bookedSlots array. if the slot already exists in bookedSlots do not include it in remainingSlots;
      options.forEach(option => {
        const optionBooked = alreadyBooked.filter(book => book.treatmentName === option.name);
        const bookedSlots = optionBooked.map(book => book.timeSlot);
        const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));

        option.slots = remainingSlots;
      })

      res.send(options)
    })

    app.get('/v2/appointmentOptions', async (req, res) => {
      const date = req.query.date;

      const pipeline = [
        {
          $lookup: {
            from: 'bookings',
            localField: 'name',
            foreignField: 'treatmentName',
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$appointmentDate', date]
                  }
                }
              }
            ],
            as: 'booked'
          }
        },
        {
          $project: {
            name: 1,
            price: 1,
            slots: 1,
            booked: {
              $map: {
                input: '$booked',
                as: 'book',
                in: '$$book.timeSlot',
              }
            }
          }
        },
        {
          $project: {
            name: 1,
            price: 1,
            slots: {
              $setDifference: ['$slots', '$booked']
            }
          }
        }
      ]

      const options = await apptOptionsCollection.aggregate(pipeline).toArray();

      res.send(options);
    })

    // get appointment options as specialty options only
    app.get('/specialtyOptions', async (req, res) => {
      const query = {};
      const project = {
        name: 1
      }

      const result = await apptOptionsCollection.find(query).project(project).toArray();

      res.send(result);
    })

    // get all the bookings for user with email 
    app.get('/bookings', verifyJwt, async (req, res) => {
      const email = req.query.email;

      const decodedEmail = req.decoded.email;

      if (email !== decodedEmail) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      const query = { email: email }

      const bookings = await bookingsCollection.find(query).sort({ _id: -1 }).toArray();

      res.send(bookings);
    })

    // get a single booking data for user
    app.get('/bookings/:id', async (req, res) => {
      const id = req.params.id;

      const query = { _id: ObjectId(id) };

      const booking = await bookingsCollection.findOne(query);

      res.send(booking);
    })

    // post booking of user and save it to database
    app.post('/bookings', verifyJwt, async (req, res) => {
      const booking = req.body;

      booking.treatmentId = ObjectId(booking.treatmentId);

      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatmentId: booking.treatmentId
      }

      const count = await bookingsCollection.countDocuments(query);

      if (count) {
        const message = `You already have a booking on ${booking.appointmentDate}`

        return res.send({ acknowledged: false, message })
      }

      const result = await bookingsCollection.insertOne(booking);

      res.send(result);
    })

    // create new user with name and email
    app.post('/users', async (req, res) => {
      const user = req.body;

      const result = await usersCollection.insertOne(user);

      res.send(result);
    })

    // check if user is admin
    app.get('/users/admin/:email', async (req, res) => {
      const email = req.params.email;

      const query = { email: email }

      const user = await usersCollection.findOne(query);

      // console.log(user)

      res.send({ isAdmin: user?.role === 'admin' });
    })

    // get all users (admin route)
    app.get('/users', verifyJwt, verifyAdmin, async (req, res) => {
      const query = {};

      const users = await usersCollection.find(query).toArray();

      res.send(users);
    })

    // update an user to admin (admin route)
    app.put('/users/admin/:id', verifyJwt, verifyAdmin, async (req, res) => {
      const id = req.params.id;

      const filter = { _id: ObjectId(id) };
      const options = { upsert: true }
      const updateDoc = {
        $set: {
          role: 'admin'
        }
      }

      const result = await usersCollection.updateOne(filter, updateDoc, options);

      res.send(result)
    })


    // get all doctors data from mongodb
    app.get('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
      const query = {};

      const doctors = await doctorsCollection.find(query).toArray();

      res.send(doctors);
    })

    // post a new doctor and create in mongodb
    app.post('/doctors', verifyJwt, verifyAdmin, async (req, res) => {
      const doctor = req.body;

      const result = await doctorsCollection.insertOne(doctor);

      res.send(result);
    })

    // delete a doctor
    app.delete('/doctors/:id', verifyJwt, verifyAdmin, async (req, res) => {
      const id = req.params.id;

      const query = { _id: ObjectId(id) };

      const result = await doctorsCollection.deleteOne(query);

      res.send(result);
    })

    // Create a PaymentIntent with the order amount and currency
    app.post('/create-payment-intent', verifyJwt, async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        "payment_method_types": [
          "card"
        ],
      })

      res.send({
        clientSecret: paymentIntent.client_secret
      })
    })

    // post payment information in mongodb database
    app.post('/payments', verifyJwt, async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);

      const id = payment.bookingId;
      const filter = { _id: ObjectId(id) };
      const updateDoc = {
        $set: {
          isPaid: true,
          transactionId: payment.transactionId,
          transactionTime: payment.transactionTime
        }
      }
      const updateResult = await bookingsCollection.updateOne(filter, updateDoc);

      res.send(result);
    })

    // get jwt token for user
    app.get('/jwt', async (req, res) => {
      const email = req.query.email;

      const query = { email: email }
      const user = await usersCollection.findOne(query);

      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: '1d'
        })

        return res.send({ accessToken: token })
      }

      res.status(403).send({ accessToken: '' });
    })

    // temporary update price field on appointment options
    // app.get('/add-price', async (req, res) => {
    //   const filter = {};
    //   const updateDoc = {
    //     $set: {
    //       price: 199
    //     }
    //   }
    //   const options = { upsert: false };

    //   const result = await apptOptionsCollection.updateMany(filter, updateDoc, options)
    //   res.send(result)
    // })

  } finally {

  }
}

run().catch(err => console.error(err))

app.get("/", (req, res) => {
  res.send("doctors portal server running")
})

app.listen(port, () => {
  console.log(`doctors portal running on port: ${port}`);
})