const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();

const port = process.env.PORT || 5000;
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.n9sry.mongodb.net/?retryWrites=true&w=majority`;

// middlewares
app.use(cors());
app.use(express.json());


const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

const run = async () => {
  try {
    const doctorsPortalDb = client.db("doctorsPortal");
    const apptOptionsCollection = doctorsPortalDb.collection("appointmentOptions");
    const bookingsCollection = doctorsPortalDb.collection("bookings");

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
            slots: {
              $setDifference: ['$slots', '$booked']
            }
          }
        }
      ]

      const options = await apptOptionsCollection.aggregate(pipeline).toArray();

      res.send(options);
    })

    app.post('/bookings', async (req, res) => {
      const booking = req.body;

      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatment: booking.treatment
      }

      const count = await bookingsCollection.countDocuments(query);

      if (count) {
        const message = `You already have a booking on ${booking.appointmentDate}`

        return res.send({ acknowledged: false, message })
      }

      booking.treatmentId = ObjectId(booking.treatmentId);
      delete booking.treatmentId;

      const result = await bookingsCollection.insertOne(booking);

      res.send(result);
    })

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